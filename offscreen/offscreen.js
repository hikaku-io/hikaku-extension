// Offscreen document (Chrome only): hosts the model runner. Unlike the MV3
// service worker it stays alive for the whole browser session, so the model
// only loads once.
import { classify, getStatus, warmup } from '../lib/runner.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'status') {
    sendResponse(getStatus());
    return false;
  }
  if (msg.type === 'warmup') {
    warmup().then(sendResponse);
    return true;
  }
  if (msg.type === 'classify') {
    classify(msg.url, msg.inspect, msg.secondOpinion).then(sendResponse, (err) => sendResponse({ status: 'error', reason: String(err?.message || err) }));
    return true;
  }
  return false;
});
