/** Independent acceptance fixture, intentionally not part of the implementation. */
import http from 'node:http';

const html = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Open CUA Acceptance Lab</title>
<link rel="stylesheet" href="/lab.css"></head>
<body>
  <h1>Browser compatibility lab</h1>
  <p id="status" role="status">Ready</p>
  <button id="theme" aria-label="Switch to dark mode">Switch to dark mode</button>
  <button id="count" data-testid="counter">Increase counter</button><output id="counter">0</output>
  <div class="inputs"><label for="name">Display name</label><input id="name" placeholder="Type your name">
  <label for="notes">Notes</label><textarea id="notes" placeholder="Multiline notes"></textarea>
  <label><input id="agree" type="checkbox">Remember this choice</label>
  <label for="fruit">Fruit</label><select id="fruit"><option value="apple">Apple</option><option value="pear">Pear</option></select>
  <div id="editor" contenteditable="true" role="textbox" aria-label="Rich text">Editable text</div></div>
  <button id="disabled" disabled>Disabled action</button>
  <details id="details"><summary>More information</summary><p>Expanded content</p></details>
  <div role="list"><div role="listitem" class="item">Alpha</div><div role="listitem" class="item">Beta</div><div role="listitem" class="item">Gamma</div></div>
  <button id="alert">Show alert</button><button id="confirm">Show confirm</button><button id="prompt">Show prompt</button>
  <a id="next" href="/second">Second page</a>
  <a id="download" href="/download.txt" download="fixture-download.txt">Download fixture</a>
  <input id="upload" type="file" aria-label="Choose local fixture">
  <img id="asset" src="/pixel.svg" alt="Fixture asset" width="84" height="48">
  <iframe id="child" name="child" src="/frame" title="Nested form"></iframe>
  <div id="scrollbox" tabindex="0" style="height:90px;overflow:auto;width:280px"><div style="height:700px">Scrollable start<br><span style="position:relative;top:550px">Scrollable end</span></div></div>
  <input id="slider" type="range" min="0" max="100" value="20" aria-label="Volume">
  <form id="local-form"><input name="value" aria-label="Local submitted value"><button type="submit">Submit local form</button></form>
  <p id="cookie"></p><footer style="margin-top:150px">End of fixture</footer>
<script>
  const status = document.querySelector('#status');
  document.querySelector('#theme').onclick = () => {
    document.documentElement.classList.toggle('dark');
    const dark = document.documentElement.classList.contains('dark');
    const button = document.querySelector('#theme');
    button.textContent = button.ariaLabel = dark ? 'Switch to light mode' : 'Switch to dark mode';
    status.textContent = dark ? 'Dark theme' : 'Light theme';
  };
  document.querySelector('#count').onclick = () => {const out=document.querySelector('#counter');out.value=String(Number(out.value)+1);};
  document.querySelector('#alert').onclick = () => alert('Fixture alert');
  document.querySelector('#confirm').onclick = () => {status.textContent='Confirm: '+confirm('Confirm fixture?');};
  document.querySelector('#prompt').onclick = () => {status.textContent='Prompt: '+prompt('Your fixture text','initial');};
  document.querySelector('#local-form').onsubmit = async event => {
    event.preventDefault();const r=await fetch('/submitted',{method:'POST',body:new FormData(event.target)});status.textContent=await r.text();
  };
  document.cookie = 'acceptance_profile=isolated; SameSite=Strict; path=/';
  document.querySelector('#cookie').textContent = 'Fixture cookie set';
  console.log('acceptance-console-message');
  console.warn('acceptance-warning-message');
  window.addEventListener('error', e => console.log('fixture-error',e.message));
  const fixtureModelContext = document.modelContext || navigator.modelContext;
  if (fixtureModelContext && typeof fixtureModelContext.registerTool === 'function') {
    fixtureModelContext.registerTool({name:'fixture_echo',description:'Echo input in the isolated local acceptance fixture',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},execute:async ({text})=>({content:[{type:'text',text:'Fixture echo: '+text}]})});
  }
</script></body></html>`;

export async function startFixture({ port = 0 } = {}) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const respond = (type, body, status = 200, extra = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
      res.end(body);
    };
    if (url.pathname === '/lab.css')
      return respond(
        'text/css',
        'body{font:15px system-ui;margin:24px;background:rgb(247,248,250);color:#192331}html.dark body{background:rgb(18,22,30);color:#eceff5}button,input,select,textarea{margin:6px;padding:8px}button,a,input{cursor:pointer}.inputs{display:grid;grid-template-columns:160px 350px;align-items:center;max-width:620px}#editor{border:1px solid #8b95a5;min-height:40px;padding:8px}iframe{display:block;width:570px;height:125px}',
      );
    if (url.pathname === '/pixel.svg')
      return respond(
        'image/svg+xml',
        '<svg xmlns="http://www.w3.org/2000/svg" width="84" height="48"><rect width="84" height="48" fill="#3176cc"/><text x="9" y="29" fill="white">CUA</text></svg>',
      );
    if (url.pathname === '/download.txt')
      return respond('text/plain', 'Actual downloaded fixture content\n', 200, {
        'Content-Disposition': 'attachment; filename="fixture-download.txt"',
      });
    if (url.pathname === '/frame')
      return respond(
        'text/html',
        '<!doctype html><html><head><title>Child frame</title></head><body><label>Frame value <input id="frame-input"></label><button id="frame-button" onclick="this.textContent=\'Frame clicked\'">Frame action</button><iframe id="grandchild" src="/grandchild" title="Deep frame"></iframe></body></html>',
      );
    if (url.pathname === '/grandchild')
      return respond(
        'text/html',
        '<!doctype html><html><body><button onclick="this.textContent=\'Deep clicked\'">Deep action</button></body></html>',
      );
    if (url.pathname === '/second')
      return respond(
        'text/html',
        '<!doctype html><html><head><title>Second fixture page</title></head><body><h1>Second page</h1><a href="/">Back to lab</a></body></html>',
      );
    if (url.pathname === '/submitted') {
      let text = '';
      for await (const chunk of req) text += chunk;
      received.push({ method: req.method, text });
      return respond('text/plain', 'Local submission accepted');
    }
    if (url.pathname === '/received') return respond('application/json', JSON.stringify(received));
    if (url.pathname === '/favicon.ico') return respond('text/plain', '', 204);
    return respond('text/html', html);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const fixture = await startFixture({ port: Number(process.env.FIXTURE_PORT || 38573) });
  console.log(fixture.url);
}
