import type { APIRoute } from 'astro'
import { loadScenes } from '../../scene/scenes'

/** Every scene's name and colours, for the Worker that picks one per request. */
export const GET: APIRoute = async () => Response.json(await loadScenes())
