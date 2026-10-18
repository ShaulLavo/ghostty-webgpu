# ghostty-webgpu-shaders

Optional compiled shader effects for a `ghostty-webgpu` terminal.

```sh
npm install ghostty-webgpu ghostty-webgpu-shaders
```

```ts
import { createShaderAddon } from 'ghostty-webgpu-shaders'
import compiled from './effect.js'

const effect = terminal.use(createShaderAddon(compiled))
await effect.api.ready
// Later:
effect.dispose()
```

Supply compiled WGSL, GLSL ES 3.00, or both. The package has no compiler dependency.

[Usage and lifecycle](docs/usage.md) · [Shader bindings](docs/bindings.md)
