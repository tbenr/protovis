import {
  fetchForkChoice,
  unwrapForkChoiceResponse,
  forkChoiceNodeKey,
  resolveParentKey,
  ForkChoiceApiVersion,
  ptcVoteFractions,
  parseStandardDump,
  FAR_FUTURE_SLOT,
} from './forkChoiceApi'

const ZERO_HASH = '0x' + '0'.repeat(64)

describe('unwrapForkChoiceResponse', () => {
  it('accepts the plain beacon-APIs shape', () => {
    const body = { fork_choice_nodes: [{ slot: '1' }] }
    expect(unwrapForkChoiceResponse(body)).toBe(body)
  })

  it('accepts a data-wrapped shape', () => {
    const inner = { fork_choice_nodes: [{ slot: '1' }] }
    expect(unwrapForkChoiceResponse({ data: inner })).toBe(inner)
  })

  it('throws when fork_choice_nodes is missing', () => {
    expect(() => unwrapForkChoiceResponse({ data: {} })).toThrow(/fork_choice_nodes/)
  })
})

describe('fetchForkChoice', () => {
  const mockFetch = (statusByUrl: { [url: string]: number }, body: any) =>
    jest.fn(async (url: string) => {
      const status = statusByUrl[url] ?? 404
      return { ok: status === 200, status, json: async () => body }
    }) as any

  it('uses v2 when available', async () => {
    const fetch = mockFetch({ 'http://n/eth/v2/debug/fork_choice': 200 }, { data: { fork_choice_nodes: [] } })
    const result = await fetchForkChoice('http://n', 'unknown', fetch)
    expect(result.version).toBe<ForkChoiceApiVersion>('v2')
    expect(result.data).toEqual({ fork_choice_nodes: [] })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to v1 when v2 is not found', async () => {
    const fetch = mockFetch({ 'http://n/eth/v1/debug/fork_choice': 200 }, { fork_choice_nodes: [] })
    const result = await fetchForkChoice('http://n', 'unknown', fetch)
    expect(result.version).toBe('v1')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('goes straight to v1 once the version is known', async () => {
    const fetch = mockFetch({ 'http://n/eth/v1/debug/fork_choice': 200 }, { fork_choice_nodes: [] })
    await fetchForkChoice('http://n', 'v1', fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('http://n/eth/v1/debug/fork_choice')
  })

  it('throws when both versions fail', async () => {
    const fetch = mockFetch({}, {})
    await expect(fetchForkChoice('http://n', 'unknown', fetch)).rejects.toThrow(/HTTP 404/)
  })
})

describe('forkChoiceNodeKey', () => {
  it('uses the block root for v1 nodes', () => {
    expect(forkChoiceNodeKey({ block_root: '0xabc' })).toBe('0xabc')
  })

  it('appends the payload status for v2 nodes', () => {
    expect(forkChoiceNodeKey({ block_root: '0xabc', payload_status: 'full' })).toBe('0xabc:full')
  })
})

describe('resolveParentKey', () => {
  // parent block 0xp with all three variants; its FULL payload hash is 0xhashP
  const parentVariants = {
    '0xp': {
      pending: { block_root: '0xp', payload_status: 'pending', execution_block_hash: '0xhashG' },
      empty: { block_root: '0xp', payload_status: 'empty', execution_block_hash: '0xhashG' },
      full: { block_root: '0xp', payload_status: 'full', execution_block_hash: '0xhashP' },
    },
    '0xold': {
      full: { block_root: '0xold', payload_status: 'full', execution_block_hash: '0xhashOld' },
    },
    '0xv1': {
      none: { block_root: '0xv1', execution_block_hash: '0xhashV1' },
    },
  }
  const childVariants = {
    '0xc': {
      pending: { block_root: '0xc', payload_status: 'pending' },
      empty: { block_root: '0xc', payload_status: 'empty' },
      full: { block_root: '0xc', payload_status: 'full' },
    },
    // pre-Gloas block as reported by v2: a lone FULL node
    '0xold2': {
      full: { block_root: '0xold2', parent_root: '0xold', payload_status: 'full', execution_block_hash: '0xhashOld2' },
    },
  }
  const byRoot = (root: string) => Object.values(parentVariants[root] ?? childVariants[root] ?? {})

  it('links EMPTY and FULL variants to their own PENDING node', () => {
    expect(resolveParentKey({ block_root: '0xc', parent_root: '0xp', payload_status: 'empty' }, byRoot)).toBe('0xc:pending')
    expect(resolveParentKey({ block_root: '0xc', parent_root: '0xp', payload_status: 'full' }, byRoot)).toBe('0xc:pending')
  })

  it('links a lone pre-Gloas FULL node through its parent root', () => {
    expect(resolveParentKey(childVariants['0xold2'].full, byRoot)).toBe('0xold:full')
  })

  it('links a PENDING child to the parent FULL node when the hash matches', () => {
    const child = { block_root: '0xc', parent_root: '0xp', payload_status: 'pending', execution_block_hash: '0xhashP' }
    expect(resolveParentKey(child, byRoot)).toBe('0xp:full')
  })

  it('links a PENDING child to the parent EMPTY node otherwise', () => {
    const child = { block_root: '0xc', parent_root: '0xp', payload_status: 'pending', execution_block_hash: '0xhashG' }
    expect(resolveParentKey(child, byRoot)).toBe('0xp:empty')
  })

  it('links to the single node of a parent without variants', () => {
    const child = { block_root: '0xc', parent_root: '0xold', payload_status: 'pending', execution_block_hash: ZERO_HASH }
    expect(resolveParentKey(child, byRoot)).toBe('0xold:full')
    const v1child = { block_root: '0xc', parent_root: '0xv1' }
    expect(resolveParentKey(v1child, byRoot)).toBe('0xv1')
  })

  it('returns the bare parent root when the parent is unknown', () => {
    expect(resolveParentKey({ block_root: '0xc', parent_root: '0xnone', payload_status: 'pending' }, byRoot)).toBe('0xnone')
  })
})

describe('ptcVoteFractions', () => {
  it('splits the committee into yes, voted-not-yes and the rest', () => {
    const node = { payload_availability_yes_count: '380', payload_attester_count: '450', payload_data_availability_yes_count: '350' }
    const f = ptcVoteFractions(node, 512)
    expect(f.yes).toBeCloseTo(380 / 512)
    expect(f.votedNotYes).toBeCloseTo(70 / 512)
    expect(f.dataYes).toBeCloseTo(350 / 512)
  })

  it('reads counts from extra_data too and treats missing counts as zero', () => {
    expect(ptcVoteFractions({ extra_data: { payload_availability_yes_count: '8', payload_attester_count: '8' } }, 16)).toEqual({ yes: 0.5, votedNotYes: 0, dataYes: 0 })
    expect(ptcVoteFractions({}, 16)).toEqual({ yes: 0, votedNotYes: 0, dataYes: 0 })
  })

  it('caps at the committee size and never lets yes exceed attesters', () => {
    const f = ptcVoteFractions({ payload_availability_yes_count: '20', payload_attester_count: '5', payload_data_availability_yes_count: '99' }, 16)
    expect(f).toEqual({ yes: 1, votedNotYes: 0, dataYes: 1 })
  })
})

describe('parseStandardDump', () => {
  const node = (slot: string) => ({ slot, block_root: '0x' + slot.padStart(64, '0'), parent_root: ZERO_HASH, weight: '1', validity: 'valid', execution_block_hash: ZERO_HASH })
  const response = {
    justified_checkpoint: { epoch: '2', root: '0xaa' },
    finalized_checkpoint: { epoch: '1', root: '0xbb' },
    fork_choice_nodes: [node('10'), node('11'), node(FAR_FUTURE_SLOT)],
    extra_data: { note: 'x' },
  }

  it('parses a plain beacon-APIs response into one snapshot without a time', () => {
    const [dump] = parseStandardDump(response)
    expect(dump.time).toBeUndefined()
    expect(dump.forkchoiceNodes.map((n: any) => n.slot)).toEqual(['10', '11'])
    expect(dump.justifiedCheckpoint).toEqual(response.justified_checkpoint)
    expect(dump.finalizedCheckpoint).toEqual(response.finalized_checkpoint)
    expect(dump.extraData).toEqual({ note: 'x' })
  })

  it('unwraps a data-wrapped response as saved from Teku', () => {
    const [dump] = parseStandardDump(JSON.stringify({ data: response }))
    expect(dump.forkchoiceNodes).toHaveLength(2)
  })

  it('restores an exported history with its timestamps', () => {
    const history = [
      { timestamp: '2026-09-24T09:00:00.000Z', forkchoiceNodes: [node('10')], justifiedCheckpoint: { epoch: '1', root: '0xaa' } },
      { timestamp: '2026-09-24T09:00:06.000Z', forkchoiceNodes: [node('10'), node('11')] },
    ]
    const dumps = parseStandardDump(JSON.stringify(history))
    expect(dumps.map(d => d.time)).toEqual(['2026-09-24T09:00:00.000Z', '2026-09-24T09:00:06.000Z'])
    expect(dumps[1].forkchoiceNodes).toHaveLength(2)
    expect(dumps[0].justifiedCheckpoint).toEqual({ epoch: '1', root: '0xaa' })
  })

  it('accepts a bare array of nodes as one snapshot', () => {
    const [dump] = parseStandardDump([node('10'), node('11'), node(FAR_FUTURE_SLOT)])
    expect(dump.forkchoiceNodes.map((n: any) => n.slot)).toEqual(['10', '11'])
    expect(dump.time).toBeUndefined()
  })

  it('rejects input without fork choice nodes', () => {
    expect(() => parseStandardDump({ data: { hello: 1 } })).toThrow(/fork_choice_nodes/)
    expect(() => parseStandardDump('[{"nope":1}]')).toThrow(/fork choice/i)
  })
})
