import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clampOverlay} from '../src/overlay';
test('keeps a user-selected position inside a normal viewport',()=>assert.deepEqual(clampOverlay({x:300,y:180},144,44,1000,700),{x:300,y:180}));
test('keeps the draggable control away from title bar and outside edges',()=>assert.deepEqual(clampOverlay({x:-200,y:-50},144,44,1000,700),{x:12,y:48}));
test('clamps a saved position when the window shrinks',()=>assert.deepEqual(clampOverlay({x:1500,y:900},144,44,500,350),{x:344,y:294}));
test('handles a viewport smaller than the button without negative coordinates',()=>assert.deepEqual(clampOverlay({x:100,y:100},144,44,100,40),{x:0,y:0}));
