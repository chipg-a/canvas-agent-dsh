/**
 * Real-composition smoke for the canvas domain: boot a Loader-mounted
 * cordis.yml (canvas-projection + session services), let the seed plugin
 * create a trunk, emit outputs, fork a branch, and assert the assembled
 * canvas tree and projection from the subprocess output.
 */

import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { fileURLToPath } from 'node:url'

const binScript = fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/canvas-domain/canvas-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/canvas-domain/cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('canvas domain through a real cordis.yml and headless process', () => {
  it('assembles the canvas tree and projection from a Loader mount', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'canvas-domain',
      tempDirPrefix: 'canvas-domain-smoke-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath],
      tsconfigPath: repoTsconfig,
    })
    expect(stderr).not.toContain('CANVAS_SMOKE_FAILURE')
    const treeLine = stdout.split('\n').find(line => line.includes('CANVAS_SMOKE_RESULT'))
    if (treeLine === undefined) throw new Error(`missing CANVAS_SMOKE_RESULT in stdout: ${stdout}`)
    const tree = JSON.parse(treeLine.slice('CANVAS_SMOKE_RESULT '.length)) as {
      trunkNodes: number
      branchCount: number
      branchNodes: number
      sessionCount: number
      nodeCount: number
    }
    expect(tree).toEqual({
      trunkNodes: 1,
      branchCount: 1,
      // The branch inherits the trunk's turn-1 node (fork seed) plus its own
      // turn-2 node, so it carries 2 nodes.
      branchNodes: 2,
      sessionCount: 2,
      nodeCount: 3,
    })
    const projectedLine = stdout.split('\n').find(line => line.includes('CANVAS_SMOKE_PROJECTED'))
    if (projectedLine === undefined) throw new Error(`missing CANVAS_SMOKE_PROJECTED in stdout: ${stdout}`)
    const projected = JSON.parse(projectedLine.slice('CANVAS_SMOKE_PROJECTED '.length)) as { nodes: number }
    expect(projected.nodes).toBe(1)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
