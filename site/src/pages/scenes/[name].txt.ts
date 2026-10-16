import { load } from 'ascii.rest'
import type { Piece } from 'ascii.rest'
import type { APIRoute, GetStaticPaths } from 'astro'
import { frameText } from '../../scene/frame'
import { loadScenes } from '../../scene/scenes'

export const getStaticPaths = (async () =>
  (await loadScenes()).map(({ name }) => ({ params: { name } }))) satisfies GetStaticPaths

/** Each scene's first frame, baked at build so the hero paints it before the terminal starts. */
export const GET: APIRoute = async ({ params }) =>
  new Response(frameText((await load[params.name as keyof typeof load]()) as Piece), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
