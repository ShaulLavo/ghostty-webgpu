export const contrastShader = /* wgsl */ `fn srgbChannelToLinear(v:f32)->f32{if(v<=0.04045){return v/12.92;}return pow((v+0.055)/1.055,2.4);}
fn luminance(c:vec3f)->f32{return dot(vec3f(srgbChannelToLinear(c.r),srgbChannelToLinear(c.g),srgbChannelToLinear(c.b)),vec3f(0.2126,0.7152,0.0722));}
fn contrastRatio(a:vec3f,b:vec3f)->f32{let hi=max(luminance(a),luminance(b));let lo=min(luminance(a),luminance(b));return(hi+0.05)/(lo+0.05);}
fn contrastColor(fg:vec3f,bg:vec3f,m:f32)->vec3f{if(m<=1.0||contrastRatio(fg,bg)>=m){return fg;}let bk=vec3f(0.0);let wh=vec3f(1.0);if(contrastRatio(wh,bg)>=contrastRatio(bk,bg)){return wh;}return bk;}
fn hasFlag(flags:u32,flag:u32)->bool{return(flags&flag)!=0u;}`
