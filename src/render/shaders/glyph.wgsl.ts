import { contrastShader } from './contrast.wgsl.js'
import { rowRemapShader } from './row-remap.wgsl.js'

export const glyphShader = /* wgsl */ `override ENABLE_TEXT_BLINK:bool=false;
const FLAG_GLYPH:u32=1u;
struct Instance{rect:vec4f,color:vec4f,uv:vec4f,background:vec4f,metadata:vec4f,atlas:vec4f,}
struct Viewport{size:vec2f,columns:u32,rowHeight:f32,rowOffset:u32,instanceCount:u32,textHidden:f32,padding:u32,}
struct VertexOutput{@builtin(position) position:vec4f,@location(0) color:vec4f,@location(1) uv:vec2f,@location(2) background:vec4f,@location(3) metadata:vec4f,}
@group(0) @binding(0) var<storage,read> instances:array<Instance>;
@group(0) @binding(1) var<uniform> viewport:Viewport;
@group(0) @binding(2) var atlasSampler:sampler;
@group(0) @binding(3) var grayscaleAtlas:texture_2d_array<f32>;
@group(0) @binding(4) var colorAtlas:texture_2d_array<f32>;
@vertex fn vertexMain(@builtin(vertex_index) vertexIndex:u32,@builtin(instance_index) instanceIndex:u32)->VertexOutput{
let corners=array<vec2f,6>(vec2f(0.0,0.0),vec2f(1.0,0.0),vec2f(0.0,1.0),vec2f(0.0,1.0),vec2f(1.0,0.0),vec2f(1.0,1.0));
${rowRemapShader}
let corner=corners[vertexIndex];
let hidden=ENABLE_TEXT_BLINK&&(u32(instance.metadata.x)&2u)!=0u&&viewport.textHidden>0.5;
let size=select(instance.rect.zw,vec2f(0.0),hidden);
let pixel=origin+corner*size;
var o:VertexOutput;
o.position=vec4f(pixel.x/viewport.size.x*2.0-1.0,1.0-pixel.y/viewport.size.y*2.0,0.0,1.0);
o.color=instance.color;o.uv=mix(instance.uv.xy,instance.uv.zw,corner);o.background=instance.background;
o.metadata=vec4f(instance.metadata.x,instance.metadata.z,instance.atlas.x,instance.atlas.z);return o;}
${contrastShader}
@fragment fn fragmentMain(i:VertexOutput)->@location(0) vec4f{
let f=u32(i.metadata.x);let mc=i.metadata.y;let hg=hasFlag(f,FLAG_GLYPH);let layer=i32(i.metadata.z);
let gs=textureSample(grayscaleAtlas,atlasSampler,i.uv,layer).r;
let cs=textureSample(colorAtlas,atlasSampler,i.uv,layer);
let cg=i.metadata.w>=0.5;
let cov=select(0.0,select(gs,cs.a,cg),hg);
let adj=contrastColor(i.color.rgb,i.background.rgb,mc);
let rgb=select(adj,cs.rgb,cg&&hg);
let a=cov*i.color.a;return vec4f(rgb*a,a);}`
