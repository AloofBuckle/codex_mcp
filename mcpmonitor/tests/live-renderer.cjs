const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const browserRoot = path.resolve(__dirname, '../../mcpbrowser');
const requireProject = createRequire(path.join(browserRoot, 'package.json'));
const acorn = requireProject('acorn');
const {chromium} = requireProject('playwright');

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.TEST_CHROME_BIN || path.join(browserRoot, '.runtime/google-chrome-root/opt/google/chrome/google-chrome'),
    headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  try {
    const sources = process.argv.length > 2 ? process.argv.slice(2) : [path.resolve(__dirname, '../static/app.js')];
    for (const sourcePath of sources) {
      const source = fs.readFileSync(sourcePath, 'utf8');
      const tree = acorn.parse(source, {ecmaVersion:'latest'});
      const wanted = ['reemoCompileShader', 'reemoCreateProgram', 'summarizeGaps',
        'connectVideoReemoMain', 'connectNativeLiveVfr'];
      const declarations = tree.body[0].expression.callee.body.body
        .filter(n => n.type === 'FunctionDeclaration' && wanted.includes(n.id.name))
        .map(n => source.slice(n.start,n.end)).join('\n');
      for (const kind of ['browser','native']) {
        const page = await browser.newPage();
        await page.setContent('<div><video id="browser-video"></video><canvas id="browser-video-canvas"></canvas><div id="browser-video-input"></div></div><div id="native-surface"><video id="native-video"></video><div id="native-placeholder"></div></div>');
        await page.addScriptTag({content: `
          const $ = id => document.getElementById(id);
          const AV1_WEBCODECS_CODEC = 'av01.0.10M.08';
          const state = {browser:{video:{generation:0,renderedFrames:0}},nativeLive:{generation:0}};
          const failVideoConnection = e => {throw e};
          const failNativeLiveConnection = failVideoConnection;
          const stopReemoMainVideoRenderer = () => {};
          const stopNativePllRenderer = () => {};
          const syncBrowserVideoStreaming = () => {};
          const syncNativeVideoStreaming = () => {};
          const handleNativeCursorMessage = () => {};
          const renderBrowser = () => {};
          const waitRtcIce = async () => {};
          let rafCallback;
          window.requestAnimationFrame = cb => { rafCallback = cb; return 1; };
          const reports = [];
          window.setInterval = cb => { reports.push(cb); return 1; };
          window.fetch = async () => ({ok:true,json:async () => ({sdp:'test',width:1920,height:1080,fps:120,selected_codec:'av1'})});
          class Channel extends EventTarget {readyState='open'; bufferedAmount=0; send() {} }
          window.RTCPeerConnection = class extends EventTarget {
            iceGatheringState='complete'; connectionState='connected'; localDescription={sdp:'test'};
            createDataChannel() { return new Channel(); }
            async createOffer() { return {sdp:'test'}; }
            async setLocalDescription() {}
            async setRemoteDescription() {}
          };
          const decodedInputs = [];
          window.VideoDecoder = class {
            static async isConfigSupported(config) { return {supported:true,config}; }
            constructor(callbacks) { this.callbacks=callbacks; }
            configure() {}
            decode(chunk) { const bytes=new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); decodedInputs.push([...bytes]); }
            decodeQueueSize=0;
          };
          ${declarations}
          window.test = {state, decodedInputs, reports, runRaf:now=>rafCallback(now),
            connect: async kind => kind==='browser' ? connectVideoReemoMain(0) : connectNativeLiveVfr(0)};
        `});
        const result = await page.evaluate(async kind => {
          const assert = (ok,msg) => { if(!ok) throw new Error(msg); };
          await test.connect(kind);
          const r = kind==='browser' ? test.state.browser.video.reemoMainRenderer : test.state.nativeLive.renderer;
          const dc = r.dc || r.videoDc;
          const packet = (id,index,count,total,bytes) => {
            const b=new Uint8Array(24+bytes.length); b.set([77,87,68,49,1,0,0,24]);
            const v=new DataView(b.buffer); v.setUint32(8,id); v.setUint32(12,id*750);
            v.setUint16(16,index); v.setUint16(18,count); v.setUint32(20,total); b.set(bytes,24);
            return b.buffer;
          };
          const send = (...args) => dc.dispatchEvent(new MessageEvent('message',{data:packet(...args)}));
          send(1,0,1,3,[1,2,3]);
          assert(JSON.stringify(test.decodedInputs)==='[[1,2,3]]','single frame includes wrong bytes');
          send(2,0,1,4,[1,2,3]);
          assert(test.decodedInputs.length===1,'malformed frame decoded');
          send(3,1,2,5,[4,5]); send(3,1,2,5,[4,5]); send(3,0,2,5,[1,2,3]);
          assert(JSON.stringify(test.decodedInputs[1])==='[1,2,3,4,5]','reorder/duplicate assembly');
          send(4,0,2,5,[1,2,3]); send(5,0,1,2,[8,9]);
          assert(JSON.stringify(test.decodedInputs[2])==='[8,9]','partial to single transition');
          send(6,0,1,1,[6]);
          assert(test.decodedInputs.length===4,'single after partial');
          assert(r.dcIncompleteFrames===2,'invalid/partial accounting changed');

          // Real WebGL uploads/draws with WebCodecs VideoFrames, without an RTC
          // server or hardware decoder requirement. Check geometry changes too.
          const frameCanvas = document.createElement('canvas');
          for (const [width,height] of [[1920,1080],[640,360]]) {
            frameCanvas.width=width; frameCanvas.height=height;
            const ctx=frameCanvas.getContext('2d'); ctx.fillStyle='rgb(255,0,0)';ctx.fillRect(0,0,width,height);
            for (let i=0;i<2;i++) r.decoder.callbacks.output(new VideoFrame(frameCanvas,{timestamp:100000+i*8333}));
            if(kind==='native') { r.vfrBasePtsUs=100000; r.vfrBaseLocalMs=performance.now()-20; }
            test.runRaf(performance.now());
            const pixel=new Uint8Array(4);r.gl.readPixels(width/2,height/2,1,1,r.gl.RGBA,r.gl.UNSIGNED_BYTE,pixel);
            assert(pixel[0]>240 && pixel[1]<10 && pixel[2]<10,'incorrect rendered pixel '+pixel);
            const viewport=Array.from(r.gl.getParameter(r.gl.VIEWPORT));
            assert(viewport[2]===width && viewport[3]===height,'viewport not updated on resize');
            assert(r.gl.getError()===0,'WebGL error after draw');
          }
          // Reports must remain valid when no new media arrives.
          test.reports.forEach(fn=>fn());
          return {kind,packetTests:6,drawSizes:2,received:r.framesReceived,decodedPayloads:test.decodedInputs.length};
        },kind);
        console.log(JSON.stringify({source:sourcePath,...result}));
        await page.close();
      }
    }
  } finally { await browser.close(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
