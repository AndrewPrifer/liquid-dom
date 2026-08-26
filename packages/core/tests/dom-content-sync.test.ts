import { describe, expect, it, vi } from 'vitest'
import { copyElementToTexture } from '../src/renderer/dom-content-sync'

describe('copyElementToTexture', () => {
  it('uses the dictionary-based HTML-in-Canvas signature', () => {
    const copyElementImageToTexture = vi.fn()
    const queue = { copyElementImageToTexture } as unknown as GPUQueue
    const source = document.createElement('div')
    const texture = {} as GPUTexture

    copyElementToTexture(queue, source, 320, 180, texture)

    expect(copyElementImageToTexture).toHaveBeenCalledOnce()
    expect(copyElementImageToTexture).toHaveBeenCalledWith(
      { source },
      {
        destination: { texture },
        width: 320,
        height: 180,
      },
    )
  })
})
