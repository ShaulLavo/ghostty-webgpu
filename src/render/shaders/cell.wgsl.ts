import { contrastShader } from './contrast.wgsl.js'
import { rowRemapShader } from './row-remap.wgsl.js'

export const cellShader = /* wgsl */ `override ENABLE_TEXT_BLINK:bool=false;
const FLAG_CURSOR:u32=1u;
const FLAG_OVERLINE:u32=2u;
const FLAG_STRIKETHROUGH:u32=4u;
struct Instance{rect:vec4f,foreground:vec4f,background:vec4f,metadata:vec4f,}
struct Viewport{size:vec2f,columns:u32,rowHeight:f32,rowOffset:u32,instanceCount:u32,textHidden:f32,padding:u32,}
struct VertexOutput{@builtin(position) position:vec4f,@location(0) foreground:vec4f,@location(1) background:vec4f,@location(2) metadata:vec4f,@location(3) local:vec2f,@location(4) size:vec2f,}
@group(0) @binding(0) var<storage,read> instances:array<Instance>;
@group(0) @binding(1) var<uniform> viewport:Viewport;
@vertex fn vertexMain(@builtin(vertex_index) vertexIndex:u32,@builtin(instance_index) instanceIndex:u32)->VertexOutput{
let corners=array<vec2f,6>(vec2f(0.0,0.0),vec2f(1.0,0.0),vec2f(0.0,1.0),vec2f(0.0,1.0),vec2f(1.0,0.0),vec2f(1.0,1.0));
${rowRemapShader}
let corner=corners[vertexIndex];let local=corner*instance.rect.zw;let pixel=origin+local;
var o:VertexOutput;
o.position=vec4f(pixel.x/viewport.size.x*2.0-1.0,1.0-pixel.y/viewport.size.y*2.0,0.0,1.0);
o.foreground=instance.foreground;o.background=instance.background;o.metadata=instance.metadata;o.local=local;o.size=instance.rect.zw;return o;}
${contrastShader}
fn lineCoverage(p:f32,c:f32)->f32{return select(0.0,1.0,floor(p)==c);}
fn underlineCoverage(s:u32,l:vec2f,z:vec2f)->f32{if(s==0u){return 0.0;}let lo=z.y-2.0;if(s==1u){return lineCoverage(l.y,lo);}if(s==2u){return max(lineCoverage(l.y,lo),lineCoverage(l.y,lo-3.0));}if(s==3u){return lineCoverage(l.y,lo-select(2.0,1.0,(l.x%4.0)<2.0));}if(s==4u){return select(0.0,1.0,(l.x%4.0)<2.0)*lineCoverage(l.y,lo);}return select(0.0,1.0,(l.x%8.0)<5.0)*lineCoverage(l.y,lo);}
fn decorationCoverage(f:u32,u:u32,l:vec2f,z:vec2f)->f32{var c=underlineCoverage(u,l,z);if(hasFlag(f,FLAG_STRIKETHROUGH)){c=max(c,lineCoverage(l.y,floor(z.y*0.52)));}if(hasFlag(f,FLAG_OVERLINE)){c=max(c,lineCoverage(l.y,1.0));}return c;}
fn cursorCoverage(f:u32,s:u32,l:vec2f,z:vec2f)->f32{if(!hasFlag(f,FLAG_CURSOR)||s==0u){return 0.0;}if(s==1u){return select(0.0,1.0,l.x<max(1.0,floor(z.x*0.15)));}if(s==2u){return select(0.0,1.0,l.y>=z.y-max(1.0,floor(z.y*0.16)));}let t=max(1.0,floor(min(z.x,z.y)*0.08));return select(0.0,1.0,min(min(l.x,z.x-l.x),min(l.y,z.y-l.y))<t);}
@fragment fn fragmentMain(i:VertexOutput)->@location(0) vec4f{
let f=u32(i.metadata.x);let u=u32(i.metadata.y);let cs=u32(i.metadata.z);let mc=i.metadata.w;
let blink=ENABLE_TEXT_BLINK&&(f&8u)!=0u&&viewport.textHidden>0.5;
let dec=select(decorationCoverage(f,u,i.local,i.size),0.0,blink);
let cur=cursorCoverage(f,cs,i.local,i.size);
let ea=max(dec,cur)*i.foreground.a;
let adj=contrastColor(i.foreground.rgb,i.background.rgb,mc);
let bg=vec4f(i.background.rgb*i.background.a,i.background.a);
let ef=vec4f(adj*ea,ea);return ef+bg*(1.0-ea);}`
