import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dilateMask, groupInk } from './uncovered.ts'

function mask(width: number, height: number, points: [number, number][]): Uint8Array {
  const data = new Uint8Array(width * height)
  for (const [x, y] of points) data[y * width + x] = 1
  return data
}

test('dilateMask: 正方形に広げ、端では切る', () => {
  const out = dilateMask(mask(5, 5, [[0, 0]]), 5, 5, 1)
  assert.deepEqual([...out.slice(0, 5)], [1, 1, 0, 0, 0])
  assert.deepEqual([...out.slice(5, 10)], [1, 1, 0, 0, 0])
  assert.equal(out[10], 0)
})

test('groupInk: 近い画素をまとめ、小さいものを捨て、上から左から並べる', () => {
  const points: [number, number][] = [
    // 右下のまとまり(4画素。間が2画素空いている)
    [30, 20], [31, 20], [34, 20], [34, 21],
    // 左上のまとまり(3画素)
    [2, 3], [3, 3], [3, 4],
    // 同じ行の右側(3画素)
    [20, 5], [21, 5], [22, 5],
    // 孤立した1画素(捨てる)
    [10, 30]
  ]
  const groups = groupInk(mask(40, 40, points), 40, 40, { mergeRadius: 2, minInk: 3, rowTolerance: 5 })
  assert.deepEqual(groups, [
    { x0: 2, y0: 3, x1: 3, y1: 4, ink: 3 },
    { x0: 20, y0: 5, x1: 22, y1: 5, ink: 3 },
    { x0: 30, y0: 20, x1: 34, y1: 21, ink: 4 }
  ])
  // まとめる半径が小さいと、離れた画素は別になって捨てられる
  assert.equal(groupInk(mask(40, 40, points), 40, 40, { mergeRadius: 0, minInk: 3, rowTolerance: 5 }).length, 2)
})
