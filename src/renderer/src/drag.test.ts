import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dragDelta } from './drag.ts'

test('ドラッグの移動量: 画面の移動を pt に直し、y は上向きにする。Shift で水平・垂直に固定する', () => {
  assert.deepEqual(dragDelta({ x: 10, y: 10 }, { x: 30, y: 50 }, 2, false), { x: 10, y: -20 })
  assert.deepEqual(dragDelta({ x: 10, y: 10 }, { x: 30, y: 50 }, 2, true), { x: 0, y: -20 })
  assert.deepEqual(dragDelta({ x: 10, y: 10 }, { x: 70, y: 0 }, 2, true), { x: 30, y: 0 })
  assert.deepEqual(dragDelta({ x: 0, y: 0 }, { x: 1, y: 0 }, 3, false), { x: 0.333, y: 0 })
  assert.deepEqual(dragDelta({ x: 5, y: 5 }, { x: 5, y: 5 }, 1, false), { x: 0, y: 0 })
})
