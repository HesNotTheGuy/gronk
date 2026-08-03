import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { codeChildrenToText } from '../src/lib/clipboard'

test('codeChildrenToText flattens nested react-markdown children', () => {
  const nested = createElement('span', null, ['line one\n', 'line two'])
  assert.equal(codeChildrenToText(nested), 'line one\nline two')
})

test('codeChildrenToText strips a trailing newline like the old code block', () => {
  assert.equal(codeChildrenToText('hello\n'), 'hello')
})
