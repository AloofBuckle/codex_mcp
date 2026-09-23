import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSource } from '../src/util/readonly-policy.mjs';

test('readonly policy permits the user-confirmed global visibility probe', () => {
  assert.equal(
    validateSource(
      '()=>({document:typeof document,window:typeof window,location:typeof location,navigator:typeof navigator,windowNavigator:typeof window.navigator})',
    ),
    true,
  );
});
test('readonly policy permits CSS/DOM inspection and local map callbacks', () => {
  for (const source of [
    '()=>getComputedStyle(document.body).backgroundColor',
    '()=>Array.from(document.querySelectorAll("button")).map(el=>({name:el.textContent,rect:el.getBoundingClientRect()}))',
    '(el)=>el.getAttribute("aria-label")',
    '()=>{const transform=x=>String(x).toUpperCase();return transform(document.title)}',
  ])
    assert.equal(validateSource(source), true, source);
});
test('readonly policy rejects direct and dynamic prototype access and native writes', () => {
  for (const source of [
    '()=>({})["con"+"structor"]',
    '()=>document.body.setAttribute("data-test","x")',
    '()=>{document.title="x";return 1}',
    '()=>document.body.constructor',
    '()=>fetch("https://example.com")',
    '()=>window["fe"+"tch"]',
    '()=>Object.getOwnPropertyDescriptors(window)',
    '()=>__cua_env__',
    '()=>arguments[0]',
  ])
    assert.throws(() => validateSource(source), /read-only|forbidden|reserved/, source);
});
test('nested/block declarations cannot whitelist an otherwise inaccessible global', () => {
  for (const source of [
    '()=>{const f=()=>{const webkitRequestFileSystem=()=>1;return 1};return webkitRequestFileSystem()}',
    '()=>{if(true){const webkitRequestFileSystem=()=>1;}return webkitRequestFileSystem()}',
    '()=>{const f=()=>{const XMLHttpRequest=()=>1;return 1};return XMLHttpRequest()}',
  ])
    assert.throws(() => validateSource(source), /not allowed|not exposed/, source);
});
