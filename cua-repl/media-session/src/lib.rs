//! Media demand belongs to a peer lease, never to a queue cursor or I/O future.
use std::{
    future::Future,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Instant,
};
use tokio::{sync::watch, task::JoinHandle};

#[derive(Clone)]
pub struct Demand(Arc<DemandInner>);
struct DemandInner {
    count: AtomicUsize,
    changed: Box<dyn Fn() + Send + Sync>,
}
impl Demand {
    pub fn new(changed: impl Fn() + Send + Sync + 'static) -> Self {
        Self(Arc::new(DemandInner {
            count: AtomicUsize::new(0),
            changed: Box::new(changed),
        }))
    }
    pub fn count(&self) -> usize {
        self.0.count.load(Ordering::Acquire)
    }
    fn acquire(&self) -> MediaLease {
        self.0.count.fetch_add(1, Ordering::AcqRel);
        (self.0.changed)();
        MediaLease(Arc::new(LeaseInner {
            demand: self.clone(),
            released: AtomicBool::new(false),
        }))
    }
}
struct LeaseInner {
    demand: Demand,
    released: AtomicBool,
}
impl LeaseInner {
    fn release(&self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            let previous = self.demand.0.count.fetch_sub(1, Ordering::AcqRel);
            debug_assert!(previous > 0, "media demand underflow");
            (self.demand.0.changed)();
        }
    }
}
impl Drop for LeaseInner {
    fn drop(&mut self) {
        self.release();
    }
}
/// Not Clone: one sender owns the lease. The peer can revoke it independently.
pub struct MediaLease(Arc<LeaseInner>);

#[derive(Clone)]
pub struct Session(Arc<SessionInner>);
struct SessionInner {
    state: Mutex<SessionState>,
    cancelled: watch::Sender<bool>,
    tasks: AtomicUsize,
    pub send: SendMetrics,
}
struct SessionState {
    closed: bool,
    media: Weak<LeaseInner>,
}
impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}
impl Session {
    pub fn new() -> Self {
        Self(Arc::new(SessionInner {
            state: Mutex::new(SessionState {
                closed: false,
                media: Weak::new(),
            }),
            cancelled: watch::channel(false).0,
            tasks: AtomicUsize::new(0),
            send: SendMetrics::default(),
        }))
    }
    pub fn is_closed(&self) -> bool {
        *self.0.cancelled.borrow()
    }
    pub fn task_count(&self) -> usize {
        self.0.tasks.load(Ordering::Acquire)
    }
    pub fn media_lease(&self, demand: &Demand) -> Option<MediaLease> {
        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closed
            || state
                .media
                .upgrade()
                .is_some_and(|m| !m.released.load(Ordering::Acquire))
        {
            return None;
        }
        let lease = demand.acquire();
        state.media = Arc::downgrade(&lease.0);
        Some(lease)
    }
    /// Synchronous and idempotent. No network wait or task completion is needed
    /// to relinquish media demand. Only terminal lifecycle events call this.
    pub fn close(&self) {
        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closed {
            return;
        }
        state.closed = true;
        if let Some(media) = state.media.upgrade() {
            media.release();
        }
        self.0.cancelled.send_replace(true);
    }
    pub async fn cancelled(&self) {
        let mut rx = self.0.cancelled.subscribe();
        let _ = rx.wait_for(|closed| *closed).await;
    }
    /// Cancellation encloses the WHOLE task, including send, cursor.changed(),
    /// RTCP and frame waits. Not a timeout/retry, and never restarts a task.
    pub fn spawn(&self, work: impl Future<Output = ()> + Send + 'static) -> JoinHandle<()> {
        let session = self.clone();
        let guard = TaskGuard(session.clone());
        self.0.tasks.fetch_add(1, Ordering::AcqRel);
        tokio::spawn(async move {
            let _guard = guard;
            tokio::select! { biased;
                _ = session.cancelled() => {},
                _ = work => {},
            }
        })
    }
    pub fn send_metrics(&self) -> &SendMetrics {
        &self.0.send
    }
    pub fn close_on_drop(&self) -> CloseOnDrop {
        CloseOnDrop(self.clone())
    }
}
pub struct CloseOnDrop(Session);
impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        self.0.close();
    }
}
struct TaskGuard(Session);
impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.0.0.tasks.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Default)]
pub struct SendMetrics {
    pending: Mutex<Option<Instant>>,
    chunks: AtomicU64,
    bytes: AtomicU64,
    max_us: AtomicU64,
    buffered: AtomicUsize,
}
impl SendMetrics {
    pub fn set_buffered(&self, bytes: usize) {
        self.buffered.store(bytes, Ordering::Relaxed);
    }
    pub fn buffered_bytes(&self) -> usize {
        self.buffered.load(Ordering::Relaxed)
    }
    pub fn begin(&self) {
        *self.pending.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    }
    pub fn end(&self) {
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
    }
    pub fn complete(&self, bytes: usize) {
        if let Some(started) = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            self.max_us
                .fetch_max(started.elapsed().as_micros() as u64, Ordering::Relaxed);
        }
        self.chunks.fetch_add(1, Ordering::Relaxed);
        self.bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }
    pub fn pending_ms(&self) -> u64 {
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .map_or(0, |at| at.elapsed().as_millis() as u64)
    }
    pub fn chunks(&self) -> u64 {
        self.chunks.load(Ordering::Relaxed)
    }
    pub fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }
}

/// Encoded AV1 is not latest-value data. After start, reject sequence gaps
/// unless the arriving frame is a standalone random-access point. Never feed
/// dependent deltas after silently dropping their references.
#[derive(Default, Debug)]
pub struct Continuity {
    previous: Option<u32>,
}
impl Continuity {
    pub fn accept(&mut self, sequence: u32, random_access: bool) -> Result<bool, &'static str> {
        match self.previous {
            None if !random_access => return Ok(false),
            Some(previous) if sequence != previous.wrapping_add(1) && !random_access => {
                return Err("AV1 reference chain discontinuity");
            }
            _ => {}
        }
        self.previous = Some(sequence);
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::pending;
    use tokio::time::{Duration, timeout};
    #[tokio::test]
    async fn closed_peer_releases_demand_even_while_send_never_returns() {
        let demand = Demand::new(|| {});
        let session = Session::new();
        let lease = session.media_lease(&demand).unwrap();
        let task = session.spawn(async move {
            let _lease = lease;
            pending::<()>().await;
        });
        assert_eq!(demand.count(), 1);
        session.close();
        assert_eq!(demand.count(), 0);
        timeout(Duration::from_millis(200), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.task_count(), 0);
        session.close();
        assert_eq!(demand.count(), 0);
        assert!(session.media_lease(&demand).is_none());
    }
    #[tokio::test]
    async fn cancellation_wakes_idle_cursor_and_late_spawn() {
        let session = Session::new();
        let (_tx, mut rx) = watch::channel(0);
        let task = session.spawn(async move {
            rx.changed().await.unwrap();
        });
        session.close();
        timeout(Duration::from_millis(200), task)
            .await
            .unwrap()
            .unwrap();
        let task = session.spawn(pending());
        timeout(Duration::from_millis(200), task)
            .await
            .unwrap()
            .unwrap();
    }
    #[test]
    fn demand_is_not_receiver_count_and_release_is_exactly_once() {
        let demand = Demand::new(|| {});
        let a = Session::new();
        let b = Session::new();
        let la = a.media_lease(&demand).unwrap();
        let lb = b.media_lease(&demand).unwrap();
        assert!(a.media_lease(&demand).is_none());
        assert_eq!(demand.count(), 2);
        a.close();
        assert_eq!(demand.count(), 1);
        drop(la);
        assert_eq!(demand.count(), 1);
        drop(lb);
        assert_eq!(demand.count(), 0);
        b.close();
        assert_eq!(demand.count(), 0);
    }
    #[test]
    fn av1_deltas_cannot_skip_references_but_sequence_wrap_is_valid() {
        let mut c = Continuity::default();
        assert_eq!(c.accept(1, false), Ok(false));
        assert_eq!(c.accept(u32::MAX, true), Ok(true));
        assert_eq!(c.accept(0, false), Ok(true));
        assert!(c.accept(2, false).is_err());
        assert_eq!(c.accept(3, true), Ok(true));
        assert_eq!(c.accept(4, false), Ok(true));
    }
    #[tokio::test]
    async fn slow_viewer_does_not_backpressure_source_or_other_viewer() {
        let (tx, mut healthy) = tokio::sync::broadcast::channel(16);
        let mut slow = tx.subscribe();
        for n in 0..1000 {
            tx.send(n).unwrap();
            assert_eq!(healthy.recv().await.unwrap(), n);
        }
        assert!(matches!(
            slow.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_))
        ));
    }
}
