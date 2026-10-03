import { describe, expect, it } from 'vitest'
import type { DbAdapter } from '../../src/main/adapters/types'
import { discoverJsonPaths } from '../../src/main/adapters/json-paths'

function adapterReturning(values: unknown[]): DbAdapter {
  return {
    sampleColumnValues: async () => values
  } as unknown as DbAdapter
}

describe('discoverJsonPaths', () => {
  it('unions paths across rows of differing shape with presentIn counts', async () => {
    const sample = await discoverJsonPaths(
      adapterReturning([
        { address1: '12 High St', city: 'Leeds' },
        { address1: '1 Low St', address2: 'Flat 2', city: 'Knaresborough' }
      ]),
      'users',
      'address'
    )

    expect(sample.sampled).toBe(2)
    expect(sample.paths.map((p) => [p.path, p.presentIn])).toEqual([
      ['address1', 2],
      ['city', 2],
      ['address2', 1]
    ])
  })

  it('accepts both verbatim JSON text (Postgres) and parsed objects (mysql2)', async () => {
    const fromText = await discoverJsonPaths(adapterReturning(['{"a":1}']), 't', 'c')
    const fromObject = await discoverJsonPaths(adapterReturning([{ a: 1 }]), 't', 'c')

    expect(fromText).toEqual(fromObject)
    expect(fromText.sampled).toBe(1)
    expect(fromText.paths).toEqual([{ path: 'a', types: ['number'], presentIn: 1 }])
  })

  it('excludes nulls, non-JSON strings and top-level arrays from the sample count', async () => {
    const sample = await discoverJsonPaths(
      adapterReturning([null, 'not json at all', '[1,2,3]', '{"ok":true}']),
      't',
      'c'
    )

    expect(sample.sampled).toBe(1)
    expect(sample.paths).toEqual([{ path: 'ok', types: ['boolean'], presentIn: 1 }])
  })

  it('reports scalar leaf types including null', async () => {
    const sample = await discoverJsonPaths(
      adapterReturning([{ s: 'x', n: 1, b: true, z: null }]),
      't',
      'c'
    )

    const types = Object.fromEntries(sample.paths.map((p) => [p.path, p.types]))
    expect(types).toEqual({
      s: ['string'],
      n: ['number'],
      b: ['boolean'],
      z: ['null']
    })
  })

  it('sorts multiple observed types at one path and merges counts', async () => {
    const sample = await discoverJsonPaths(
      adapterReturning([{ v: 'text' }, { v: 5 }, { v: 'more' }]),
      't',
      'c'
    )

    expect(sample.paths).toEqual([{ path: 'v', types: ['number', 'string'], presentIn: 3 }])
  })

  it('surfaces arrays as bindable-looking paths typed array (engine leaves them alone)', async () => {
    const sample = await discoverJsonPaths(adapterReturning([{ tags: [1, 2] }]), 't', 'c')

    expect(sample.paths).toEqual([{ path: 'tags', types: ['array'], presentIn: 1 }])
  })

  it('descends nested objects up to the depth cap, then reports the subtree as object', async () => {
    const within = await discoverJsonPaths(
      adapterReturning([{ geo: { lat: 1, long: { deep: 2 } } }]),
      't',
      'c'
    )
    const atCap = await discoverJsonPaths(
      adapterReturning([{ a: { b: { c: { d: 1 } } } }]),
      't',
      'c'
    )

    expect(within.paths.map((p) => p.path).sort()).toEqual(['geo.lat', 'geo.long.deep'])
    expect(atCap.paths).toEqual([{ path: 'a.b.c', types: ['object'], presentIn: 1 }])
  })

  it('keeps first-seen order across rows', async () => {
    const sample = await discoverJsonPaths(
      adapterReturning([
        { b: 1, a: 2 },
        { c: 3, a: 4 }
      ]),
      't',
      'c'
    )

    expect(sample.paths.map((p) => p.path)).toEqual(['b', 'a', 'c'])
  })
})
