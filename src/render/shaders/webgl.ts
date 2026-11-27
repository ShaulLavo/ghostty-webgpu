const vertexHeader = `#version 300 es
precision highp float;precision highp int;
const bool ENABLE_TEXT_BLINK = false;
uniform vec2 viewport;uniform vec4 rowLayout;uniform int firstInstance;
vec2 rowOrigin(vec4 r){if(rowLayout.x==0.0||r.w==0.0)return r.xy;int c=int(rowLayout.x);int n=int(rowLayout.w);int p=(gl_InstanceID+firstInstance)/c;int l=(p+n-int(rowLayout.z))%n;return vec2(r.x,float(l)*rowLayout.y+r.y);}
const vec2 corners[6]=vec2[6](vec2(0.0,0.0),vec2(1.0,0.0),vec2(0.0,1.0),vec2(0.0,1.0),vec2(1.0,0.0),vec2(1.0,1.0));
vec4 clipPosition(vec2 p){return vec4(p.x/viewport.x*2.0-1.0,1.0-p.y/viewport.y*2.0,0.0,1.0);}
`

const fragmentHeader = `#version 300 es
precision highp float;precision highp int;
const bool ENABLE_TEXT_BLINK = false;
out vec4 outputColor;
float srgbChannelToLinear(float v){if(v<=0.04045)return v/12.92;return pow((v+0.055)/1.055,2.4);}
float luminance(vec3 c){return dot(vec3(srgbChannelToLinear(c.r),srgbChannelToLinear(c.g),srgbChannelToLinear(c.b)),vec3(0.2126,0.7152,0.0722));}
float contrastRatio(vec3 a,vec3 b){float hi=max(luminance(a),luminance(b));float lo=min(luminance(a),luminance(b));return(hi+0.05)/(lo+0.05);}
vec3 contrastColor(vec3 fg,vec3 bg,float m){if(m<=1.0||contrastRatio(fg,bg)>=m)return fg;if(contrastRatio(vec3(1.0),bg)>=contrastRatio(vec3(0.0),bg))return vec3(1.0);return vec3(0.0);}
bool hasFlag(uint f,uint k){return(f&k)!=0u;}
`

export const cellVertexShader = `${vertexHeader}layout(location=0) in vec4 rect;layout(location=1) in vec4 foreground;layout(location=2) in vec4 background;layout(location=3) in vec4 metadata;
flat out vec4 v_foreground;flat out vec4 v_background;flat out vec4 v_metadata;out vec2 v_local;flat out vec2 v_size;
void main(){vec2 local=corners[gl_VertexID]*rect.zw;gl_Position=clipPosition(rowOrigin(rect)+local);v_foreground=foreground;v_background=background;v_metadata=metadata;v_local=local;v_size=rect.zw;}`

export const cellFragmentShader = `${fragmentHeader}uniform float textHidden;
flat in vec4 v_foreground;flat in vec4 v_background;flat in vec4 v_metadata;in vec2 v_local;flat in vec2 v_size;
float lineCoverage(float p,float c){return floor(p)==c?1.0:0.0;}
float underlineCoverage(uint s,vec2 l,vec2 z){if(s==0u)return 0.0;float lo=z.y-2.0;if(s==1u)return lineCoverage(l.y,lo);if(s==2u)return max(lineCoverage(l.y,lo),lineCoverage(l.y,lo-3.0));if(s==3u)return lineCoverage(l.y,lo-(mod(l.x,4.0)<2.0?1.0:2.0));if(s==4u)return(mod(l.x,4.0)<2.0?1.0:0.0)*lineCoverage(l.y,lo);return(mod(l.x,8.0)<5.0?1.0:0.0)*lineCoverage(l.y,lo);}
float decorationCoverage(uint f,uint u,vec2 l,vec2 z){float c=underlineCoverage(u,l,z);if(hasFlag(f,4u))c=max(c,lineCoverage(l.y,floor(z.y*0.52)));if(hasFlag(f,2u))c=max(c,lineCoverage(l.y,1.0));return c;}
float cursorCoverage(uint f,uint s,vec2 l,vec2 z){if(!hasFlag(f,1u)||s==0u)return 0.0;if(s==1u)return l.x<max(1.0,floor(z.x*0.15))?1.0:0.0;if(s==2u)return l.y>=z.y-max(1.0,floor(z.y*0.16))?1.0:0.0;float t=max(1.0,floor(min(z.x,z.y)*0.08));return min(min(l.x,z.x-l.x),min(l.y,z.y-l.y))<t?1.0:0.0;}
void main(){uint f=uint(v_metadata.x);float d=decorationCoverage(f,uint(v_metadata.y),v_local,v_size);if(ENABLE_TEXT_BLINK&&hasFlag(f,8u)&&textHidden>0.5)d=0.0;float c=cursorCoverage(f,uint(v_metadata.z),v_local,v_size);float ea=max(d,c)*v_foreground.a;vec3 adj=contrastColor(v_foreground.rgb,v_background.rgb,v_metadata.w);vec4 bg=vec4(v_background.rgb*v_background.a,v_background.a);vec4 ef=vec4(adj*ea,ea);outputColor=ef+bg*(1.0-ea);}`

export const glyphVertexShader = `${vertexHeader}layout(location=0) in vec4 rect;layout(location=1) in vec4 color;layout(location=2) in vec4 uv;layout(location=3) in vec4 background;layout(location=4) in vec4 attributes;layout(location=5) in vec4 atlas;
uniform float textHidden;flat out vec4 v_color;out vec2 v_uv;flat out vec4 v_background;flat out vec4 v_attributes;flat out vec4 v_atlas;
void main(){vec2 corner=corners[gl_VertexID];bool hidden=ENABLE_TEXT_BLINK&&(uint(attributes.x)&2u)!=0u&&textHidden>0.5;vec2 size=hidden?vec2(0.0):rect.zw;gl_Position=clipPosition(rowOrigin(rect)+corner*size);v_color=color;v_uv=mix(uv.xy,uv.zw,corner);v_background=background;v_attributes=attributes;v_atlas=atlas;}`

export const glyphFragmentShader = `${fragmentHeader}precision highp sampler2DArray;
uniform sampler2DArray grayscaleAtlas;uniform sampler2DArray colorAtlas;
flat in vec4 v_color;in vec2 v_uv;flat in vec4 v_background;flat in vec4 v_attributes;flat in vec4 v_atlas;
void main(){bool hg=hasFlag(uint(v_attributes.x),1u);vec3 coord=vec3(v_uv,v_atlas.x);float gs=texture(grayscaleAtlas,coord).r;vec4 cs=texture(colorAtlas,coord);bool cg=v_atlas.z>=0.5;float cov=cg?cs.a:gs;if(!hg)cov=0.0;vec3 rgb=contrastColor(v_color.rgb,v_background.rgb,v_attributes.z);if(cg&&hg)rgb=cs.rgb;float a=cov*v_color.a;outputColor=vec4(rgb*a,a);}`
