use std::collections::VecDeque;
use std::sync::atomic::Ordering;

use portable_atomic::{AtomicBool, AtomicUsize};
use tokio::sync::{Mutex, Semaphore};
use util::sync::RwLock;

use crate::chunk::chunk_payload_data::ChunkPayloadData;

// TODO: benchmark performance between multiple Atomic+Mutex vs one Mutex<PendingQueueInternal>

// Some tests push a lot of data before starting to process any data...
#[cfg(test)]
const QUEUE_BYTES_LIMIT: usize = 128 * 1024 * 1024;
/// Maximum size of the pending queue, in bytes.
#[cfg(not(test))]
const QUEUE_BYTES_LIMIT: usize = 128 * 1024;
/// Total user data size, beyond which the packet will be split into chunks. The chunks will be
/// added to the pending queue one by one.
const QUEUE_APPEND_LARGE: usize = (QUEUE_BYTES_LIMIT * 2) / 3;

/// Basic queue for either ordered or unordered chunks.
pub(crate) type PendingBaseQueue = VecDeque<ChunkPayloadData>;

/// A queue for both ordered and unordered chunks.
#[derive(Debug)]
pub(crate) struct PendingQueue {
    // These two fields limit appending bytes to the queue
    // This two step process is necessary because
    // A) We need backpressure which the semaphore applies by limiting the total amount of bytes via the permits
    // B) The chunks of one fragmented message need to be put in direct sequence into the queue which the lock guarantees
    //
    // The semaphore is not inside the lock because the permits need to be returned without needing a lock on the semaphore
    semaphore_lock: Mutex<()>,
    semaphore: Semaphore,
    byte_limit: usize,
    append_large_threshold: usize,

    unordered_queue: RwLock<PendingBaseQueue>,
    ordered_queue: RwLock<PendingBaseQueue>,
    queue_len: AtomicUsize,
    n_bytes: AtomicUsize,
    selected: AtomicBool,
    unordered_is_selected: AtomicBool,
}

impl Default for PendingQueue {
    fn default() -> Self {
        PendingQueue::new()
    }
}

impl PendingQueue {
    #[cfg(test)]
    pub(crate) fn with_limit(limit: usize) -> Self {
        Self { semaphore: Semaphore::new(limit), byte_limit: limit, append_large_threshold: (limit * 2 / 3).max(1), ..Self::new() }
    }

    pub(crate) fn new() -> Self {
        Self {
            semaphore_lock: Mutex::default(),
            semaphore: Semaphore::new(QUEUE_BYTES_LIMIT),
            byte_limit: QUEUE_BYTES_LIMIT,
            append_large_threshold: QUEUE_APPEND_LARGE,
            unordered_queue: Default::default(),
            ordered_queue: Default::default(),
            queue_len: Default::default(),
            n_bytes: Default::default(),
            selected: Default::default(),
            unordered_is_selected: Default::default(),
        }
    }

    /// Closing is a lifecycle event, not a retry. Wake all blocked appenders.
    pub(crate) fn close(&self) { self.semaphore.close(); }

    pub(crate) async fn push(&self, c: ChunkPayloadData) -> crate::error::Result<()> {
        self.append(vec![c]).await
    }

    pub(crate) async fn append(&self, chunks: Vec<ChunkPayloadData>) -> crate::error::Result<()> {
        self.append_and_notify(chunks, || {}).await
    }

    /// Wake the writer after *each committed fragment* of a large message,
    /// rather than after the entire append has fit into the bounded queue.
    pub(crate) async fn append_and_notify(
        &self, chunks: Vec<ChunkPayloadData>, wake: impl Fn(),
    ) -> crate::error::Result<()> {
        use crate::error::Error;
        if chunks.is_empty() { return Ok(()); }
        let total: usize = chunks.iter().map(|c| c.user_data.len()).sum();
        let _serial = self.semaphore_lock.lock().await;
        if total >= self.append_large_threshold {
            for chunk in chunks {
                let len = chunk.user_data.len();
                if len > self.byte_limit { return Err(Error::ErrOutboundPacketTooLarge); }
                self.semaphore.acquire_many(len as u32).await
                    .map_err(|_| Error::ErrStreamClosed)?.forget();
                self.append_unlimited(vec![chunk], len);
                wake();
            }
        } else {
            self.semaphore.acquire_many(total as u32).await
                .map_err(|_| Error::ErrStreamClosed)?.forget();
            self.append_unlimited(chunks, total);
            wake();
        }
        Ok(())
    }

    fn append_unlimited(&self, chunks: Vec<ChunkPayloadData>, total: usize) {
        let unordered = chunks[0].unordered;
        assert!(chunks.iter().all(|c| c.unordered == unordered));
        let mut queue = if unordered { self.unordered_queue.write() } else { self.ordered_queue.write() };
        // Publish counters before exposing elements to the concurrent consumer.
        // Previously it could pop a visible chunk and underflow n_bytes/len.
        self.n_bytes.fetch_add(total, Ordering::SeqCst);
        self.queue_len.fetch_add(chunks.len(), Ordering::SeqCst);
        queue.extend(chunks);
    }

    pub(crate) fn peek(&self) -> Option<ChunkPayloadData> {
        if self.selected.load(Ordering::SeqCst) {
            if self.unordered_is_selected.load(Ordering::SeqCst) {
                let unordered_queue = self.unordered_queue.read();
                return unordered_queue.front().cloned();
            } else {
                let ordered_queue = self.ordered_queue.read();
                return ordered_queue.front().cloned();
            }
        }

        let c = {
            let unordered_queue = self.unordered_queue.read();
            unordered_queue.front().cloned()
        };

        if c.is_some() {
            return c;
        }

        let ordered_queue = self.ordered_queue.read();
        ordered_queue.front().cloned()
    }

    pub(crate) fn pop(
        &self,
        beginning_fragment: bool,
        unordered: bool,
    ) -> Option<ChunkPayloadData> {
        let popped = if self.selected.load(Ordering::SeqCst) {
            let popped = if self.unordered_is_selected.load(Ordering::SeqCst) {
                let mut unordered_queue = self.unordered_queue.write();
                unordered_queue.pop_front()
            } else {
                let mut ordered_queue = self.ordered_queue.write();
                ordered_queue.pop_front()
            };
            if let Some(p) = &popped {
                if p.ending_fragment {
                    self.selected.store(false, Ordering::SeqCst);
                }
            }
            popped
        } else {
            if !beginning_fragment {
                return None;
            }
            if unordered {
                let popped = {
                    let mut unordered_queue = self.unordered_queue.write();
                    unordered_queue.pop_front()
                };
                if let Some(p) = &popped {
                    if !p.ending_fragment {
                        self.selected.store(true, Ordering::SeqCst);
                        self.unordered_is_selected.store(true, Ordering::SeqCst);
                    }
                }
                popped
            } else {
                let popped = {
                    let mut ordered_queue = self.ordered_queue.write();
                    ordered_queue.pop_front()
                };
                if let Some(p) = &popped {
                    if !p.ending_fragment {
                        self.selected.store(true, Ordering::SeqCst);
                        self.unordered_is_selected.store(false, Ordering::SeqCst);
                    }
                }
                popped
            }
        };

        if let Some(p) = &popped {
            let user_data_len = p.user_data.len();
            self.n_bytes.fetch_sub(user_data_len, Ordering::SeqCst);
            self.queue_len.fetch_sub(1, Ordering::SeqCst);
            self.semaphore.add_permits(user_data_len);
        }

        popped
    }

    pub(crate) fn get_num_bytes(&self) -> usize {
        self.n_bytes.load(Ordering::SeqCst)
    }

    pub(crate) fn len(&self) -> usize {
        self.queue_len.load(Ordering::SeqCst)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod lifecycle_regressions {
    use super::*;
    use std::sync::Arc;
    use bytes::Bytes;
    use tokio::time::{timeout, Duration};
    fn fragment(first: bool, last: bool, data: Bytes) -> ChunkPayloadData {
        ChunkPayloadData { beginning_fragment:first, ending_fragment:last, user_data:data, ..Default::default() }
    }
    #[tokio::test]
    async fn closed_queue_wakes_all_blocked_appenders() {
        let q=Arc::new(PendingQueue::with_limit(128*1024));
        q.push(fragment(true,true,Bytes::from(vec![1;128*1024]))).await.unwrap();
        let mut tasks=Vec::new();
        for _ in 0..4 { let q=q.clone(); tasks.push(tokio::spawn(async move { q.push(fragment(true,true,Bytes::from_static(b"wait"))).await })); }
        tokio::task::yield_now().await; q.close();
        for task in tasks { assert!(timeout(Duration::from_millis(200),task).await.unwrap().unwrap().is_err()); }
    }
    #[tokio::test]
    async fn large_append_wakes_writer_before_queue_capacity_is_exhausted() {
        let q=Arc::new(PendingQueue::with_limit(128*1024));
        let (wake,mut wakes)=tokio::sync::mpsc::channel(1);
        let producer=q.clone();
        let task=tokio::spawn(async move {
            let chunks=(0..256).map(|n| fragment(n==0,n==255,Bytes::from(vec![0;1024]))).collect();
            producer.append_and_notify(chunks, || { let _=wake.try_send(()); }).await.unwrap();
        });
        timeout(Duration::from_secs(2),async {
            let mut count=0;
            while count<256 {
                wakes.recv().await.unwrap();
                while let Some(c)=q.peek() { assert!(q.get_num_bytes()<=128*1024); assert!(q.pop(c.beginning_fragment,c.unordered).is_some()); count+=1; }
            }
            task.await.unwrap();
        }).await.unwrap();
        assert_eq!(q.get_num_bytes(),0); assert_eq!(q.len(),0);
    }
    #[tokio::test(flavor="multi_thread", worker_threads=2)]
    async fn publish_counters_before_chunks_are_visible() {
        let q=Arc::new(PendingQueue::with_limit(1024));
        let producer=q.clone();
        let task=tokio::spawn(async move {
            for _ in 0..10000 { producer.push(fragment(true,true,Bytes::from_static(b"12345678"))).await.unwrap(); }
        });
        for _ in 0..10000 {
            loop {
                if let Some(c)=q.peek() { q.pop(c.beginning_fragment,c.unordered).unwrap(); break; }
                tokio::task::yield_now().await;
            }
            assert!(q.len()<=128); assert!(q.get_num_bytes()<=1024);
        }
        task.await.unwrap(); assert_eq!(q.get_num_bytes(),0); assert_eq!(q.len(),0);
    }
}
