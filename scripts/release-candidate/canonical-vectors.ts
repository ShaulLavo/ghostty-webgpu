import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalObjectBytes, sha256 } from '../config-resolver-native/canonical'
import { ReleaseCandidateError } from './validation'

const VECTORS = [
  {
    name: 'nested-integer-array-utf8',
    value: { arrays: [0, 1, 9_007_199_254_740_991], nested: { z: '雪', a: true } },
    hex: '7b22617272617973223a5b302c312c393030373139393235343734303939315d2c226e6573746564223a7b2261223a747275652c227a223a22e99baa227d7d0a',
    sha256: '0cb28e3aaf266647eb00d29c0791aad44c3a8f4cf1e2441cb546fb1df93d39db',
  },
  {
    name: 'utf8-key-and-negative-boundary',
    value: { '\u00e9': ['\u00e9', { b: -1, a: null }], a: 'ascii' },
    hex: '7b2261223a226173636969222c22c3a9223a5b22c3a9222c7b2261223a6e756c6c2c2262223a2d317d5d7d0a',
    sha256: '990080853e511b45c94c78bc9dbe765852e10f49a1c35030b41d6f5d3c4d0e4a',
  },
] as const

export function verifyReleaseCanonicalVectors(): Buffer {
  for (const vector of VECTORS) {
    const bytes = canonicalObjectBytes(vector.value)
    if (bytes.toString('hex') !== vector.hex || sha256(bytes) !== vector.sha256) {
      throw new ReleaseCandidateError('release canonical vector differs')
    }
  }
  return canonicalObjectBytes({ schemaVersion: 1, status: 'pass', vectors: VECTORS.length })
}

function isDirectInvocation(): boolean {
  const executable = process.argv[1]
  if (!executable) return false
  return resolve(executable) === resolve(fileURLToPath(import.meta.url))
}

if (isDirectInvocation()) process.stdout.write(verifyReleaseCanonicalVectors())
