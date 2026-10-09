// test/chatLimiter.test.mjs
//
// Offline tests for the POST /api/chat abuse limiter (createChatRequestLimiter
// in server/index.mjs): 10 requests per minute per IP, and at most 2 model
// calls in flight at once, both returning 429 before the handler ever runs.
//
// server/index.mjs only boots an Express server/LD client when it is run as
// the program entry point (see the isMainModule guard at the bottom of that
// file), so importing createChatRequestLimiter from it here has no such
// side effect: no network, no port, no LaunchDarkly client.
//
// req/res are faked rather than pulled from a real Express app: the
// limiter only reads req.ip and calls res.status().json(), and signals
// "the request is done" via the 'finish'/'close' events on res, which is
// all a plain EventEmitter needs to stand in for.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createChatRequestLimiter } from '../server/index.mjs';

function fakeReq(ip) {
  return { ip };
}

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = undefined;
  res.body = undefined;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    // A real Express response emits 'finish' once it has actually been
    // sent; res.json() here stands in for that whole round trip.
    res.emit('finish');
    return res;
  };
  // finishRequest() mimics a handler downstream of the limiter completing
  // successfully and Express emitting 'finish' once the response is sent.
  res.finishRequest = () => res.emit('finish');
  return res;
}

describe('createChatRequestLimiter (POST /api/chat abuse limits)', () => {
  test('allows requests under the per-window limit', () => {
    const limiter = createChatRequestLimiter({ maxPerWindow: 10, maxConcurrent: 2 });
    let nextCalled = 0;
    const req = fakeReq('1.2.3.4');

    for (let i = 0; i < 10; i += 1) {
      const res = fakeRes();
      limiter(req, res, () => {
        nextCalled += 1;
      });
      res.finishRequest(); // release the concurrency slot before the next request
    }

    assert.equal(nextCalled, 10);
  });

  test('the 11th request within a minute from the same IP gets 429, next() is not called', () => {
    const limiter = createChatRequestLimiter({ maxPerWindow: 10, maxConcurrent: 2 });
    const req = fakeReq('5.5.5.5');

    for (let i = 0; i < 10; i += 1) {
      const res = fakeRes();
      limiter(req, res, () => {});
      res.finishRequest();
    }

    let nextCalled = false;
    const res = fakeRes();
    limiter(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
    assert.ok(res.body.error);
  });

  test('a different IP is not affected by another IP exhausting its window', () => {
    const limiter = createChatRequestLimiter({ maxPerWindow: 1, maxConcurrent: 5 });

    const resA = fakeRes();
    limiter(fakeReq('10.0.0.1'), resA, () => {});
    resA.finishRequest();

    // Same IP, second request: should be blocked.
    const resA2 = fakeRes();
    let nextCalledA2 = false;
    limiter(fakeReq('10.0.0.1'), resA2, () => {
      nextCalledA2 = true;
    });
    assert.equal(nextCalledA2, false);
    assert.equal(resA2.statusCode, 429);

    // A different IP's first request still goes through.
    const resB = fakeRes();
    let nextCalledB = false;
    limiter(fakeReq('10.0.0.2'), resB, () => {
      nextCalledB = true;
    });
    assert.equal(nextCalledB, true);
  });

  test('a 3rd concurrent request gets 429 when maxConcurrent is 2, until a slot frees up', () => {
    const limiter = createChatRequestLimiter({ maxPerWindow: 100, maxConcurrent: 2 });
    const req = fakeReq('9.9.9.9');

    const res1 = fakeRes();
    limiter(req, res1, () => {}); // in flight, slot 1

    const res2 = fakeRes();
    limiter(req, res2, () => {}); // in flight, slot 2

    const res3 = fakeRes();
    let nextCalled3 = false;
    limiter(req, res3, () => {
      nextCalled3 = true;
    });
    assert.equal(nextCalled3, false, 'a 3rd concurrent request must be rejected while 2 are in flight');
    assert.equal(res3.statusCode, 429);

    // Freeing one in-flight slot (res1's request finishes) makes room for
    // the next request.
    res1.finishRequest();

    const res4 = fakeRes();
    let nextCalled4 = false;
    limiter(req, res4, () => {
      nextCalled4 = true;
    });
    assert.equal(nextCalled4, true, 'a slot freed by a finished request should admit the next one');
  });

  test('releasing a slot is idempotent across both finish and close firing', () => {
    const limiter = createChatRequestLimiter({ maxPerWindow: 100, maxConcurrent: 1 });
    const req = fakeReq('7.7.7.7');

    const res1 = fakeRes();
    limiter(req, res1, () => {});
    // Both events can fire for the same request in a real server (a
    // response that finishes normally still emits 'close' on some Node
    // versions); the slot must only be released once.
    res1.emit('finish');
    res1.emit('close');

    const res2 = fakeRes();
    let nextCalled2 = false;
    limiter(req, res2, () => {
      nextCalled2 = true;
    });
    assert.equal(nextCalled2, true);
  });
});
