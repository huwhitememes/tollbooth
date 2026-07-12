// === LUMEN CHROME SHADER BACKGROUND ===
(function() {
  const canvas = document.getElementById('shader-bg');
  if (!canvas) return;

  const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'low-power' });
  if (!gl) { canvas.style.display = 'none'; return; }

  const VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  const FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform vec2  u_res;
uniform float u_phase;
uniform float u_seed;

uniform vec3  u_c1, u_c2, u_c3, u_c4, u_bg;
uniform float u_hue, u_sat, u_exposure, u_contrast;
uniform float u_scale, u_complex, u_warp, u_flow, u_stretch;
uniform float u_light, u_gloss, u_lightAngle, u_irid, u_glow;
uniform float u_grain, u_ca, u_vig, u_travel;

out vec4 fragColor;

#define TAU 6.28318530718
#define PI  3.14159265359

/* ---------------- noise ---------------- */

/* fract-first hashes stay precise for large inputs (big seeds, far cells) */

float hash11(float n){
  n = fract(n * 0.1031);
  n *= n + 33.33;
  n *= n + n;
  return fract(n);
}

float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p){
  float n = hash21(p);
  return vec2(n, hash21(p+n+17.13));
}


float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  float a = hash21(i);
  float b = hash21(i+vec2(1,0));
  float c = hash21(i+vec2(0,1));
  float d = hash21(i+vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}


mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }


float fbm(vec2 p){
  float v = 0.0, a = 0.5, tot = 0.0;
  mat2 R = rot(0.62);
  for (int i = 0; i < 8; i++){
    float w = clamp(u_complex - float(i), 0.0, 1.0);
    if (w <= 0.0) break;
    v += a*w*vnoise(p);
    tot += a*w;
    a *= 0.55;
    p = R*p*2.03 + 11.7;
  }
  return v/max(tot, 1e-4);
}


/* loop offset: orbit in noise space -> perfect loop */
vec2 LT(){ return vec2(cos(TAU*u_phase), sin(TAU*u_phase)) * u_travel; }
vec2 SO(){ return vec2(hash11(u_seed*0.137 + 0.731)*61.7, hash11(u_seed*0.213 + 7.0)*47.3); }


vec3 palette(float t){
  t = clamp(t, 0.0, 1.0);
  float x = t*3.0;
  vec3 c = mix(u_c1, u_c2, smoothstep(0.0,1.0,x));
  c = mix(c, u_c3, smoothstep(1.0,2.0,x));
  c = mix(c, u_c4, smoothstep(2.0,3.0,x));
  return c;
}

vec3 paletteCyc(float t){
  t = fract(t);
  float x = t*4.0;
  vec3 c = mix(u_c1, u_c2, smoothstep(0.0,1.0,x));
  c = mix(c, u_c3, smoothstep(1.0,2.0,x));
  c = mix(c, u_c4, smoothstep(2.0,3.0,x));
  c = mix(c, u_c1, smoothstep(3.0,4.0,x));
  return c;
}


vec3 hueRotate(vec3 c, float deg){
  float a = deg*PI/180.0;
  float cs = cos(a), sn = sin(a);
  mat3 m = mat3(
    0.299+0.701*cs+0.168*sn, 0.587-0.587*cs+0.330*sn, 0.114-0.114*cs-0.497*sn,
    0.299-0.299*cs-0.328*sn, 0.587+0.413*cs+0.035*sn, 0.114-0.114*cs+0.292*sn,
    0.299-0.300*cs+1.250*sn, 0.587-0.588*cs-1.050*sn, 0.114+0.886*cs-0.203*sn);
  return c*m;
}


vec2 toP(vec2 uv){
  float asp = u_res.x/u_res.y;
  vec2 p = (uv - 0.5) * vec2(asp, 1.0) * (3.0/max(u_scale, 0.15));
  p.x *= mix(1.0, 0.38, clamp(u_stretch, 0.0, 1.0));
  p.y *= mix(1.0, 0.38, clamp(-u_stretch, 0.0, 1.0));
  return p;
}




vec3 scene(vec2 uv){ return sceneChrome(uv); }

void main(){
  vec2 uv = gl_FragCoord.xy/u_res;
  vec3 col = scene(uv);

  /* chromatic fringe */
  if (u_ca > 0.004){
    float asp0 = u_res.x/u_res.y;
    float r2 = length((uv - 0.5)*vec2(asp0, 1.0));
    float w = clamp(u_ca, 0.0, 1.0)*smoothstep(0.18, 0.85, r2)*0.45;
    vec3 shifted = vec3(
      hueRotate(col,  10.0).r,
      col.g,
      hueRotate(col, -10.0).b);
    col = mix(col, shifted, w);
  }

  /* glow */
  float lum = dot(col, vec3(0.299,0.587,0.114));
  col += u_glow * col * lum * 0.85;

  /* grade */
  if (abs(u_hue) > 0.5) col = hueRotate(col, u_hue);
  float l2 = dot(col, vec3(0.299,0.587,0.114));
  col = mix(vec3(l2), col, u_sat);
  col *= u_exposure;
  col = (col - 0.5)*u_contrast + 0.5;

  /* vignette */
  float asp = u_res.x/u_res.y;
  vec2 vc = (uv-0.5)*vec2(asp,1.0);
  col *= 1.0 - u_vig*smoothstep(0.35, 1.05, length(vc));

  /* film grain */
  float gstep = floor(u_phase*24.0);
  float gr = hash21(gl_FragCoord.xy*0.71 + vec2(gstep*3.1, gstep*7.7));
  col += (gr-0.5)*u_grain*0.55;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('Shader error:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { canvas.style.display = 'none'; return; }

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('Link error:', gl.getProgramInfoLog(prog));
    canvas.style.display = 'none';
    return;
  }
  gl.useProgram(prog);

  // Fullscreen triangle
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  // Uniforms
  const U = {};
  ['u_res','u_phase','u_seed','u_c1','u_c2','u_c3','u_c4','u_bg',
   'u_hue','u_sat','u_exposure','u_contrast',
   'u_scale','u_complex','u_warp','u_flow','u_stretch',
   'u_light','u_gloss','u_lightAngle','u_irid','u_glow',
   'u_grain','u_ca','u_vig','u_travel'].forEach(n => U[n] = gl.getUniformLocation(prog, n));

  // Premium dark palette
  function hex3(h) {
    const r = parseInt(h.slice(1,3),16)/255;
    const g = parseInt(h.slice(3,5),16)/255;
    const b = parseInt(h.slice(5,7),16)/255;
    return [r,g,b];
  }

  const params = {
    seed: 7.3,
    c1: hex3('#1a3a5c'),   // deep blue
    c2: hex3('#2dd4bf'),   // teal
    c3: hex3('#e0f2fe'),   // silver-white
    c4: hex3('#0ea5e9'),   // sky blue
    bg: hex3('#06080c'),   // near black
    scale: 1.2,
    complex: 4.0,
    warp: 0.55,
    flow: 0.3,
    stretch: 0.0,
    light: 0.8,
    gloss: 14.0,
    lightAngle: 35.0,
    irid: 0.35,
    glow: 0.12,
    grain: 0.04,
    ca: 0.08,
    vig: 0.35,
    travel: 0.28,
    hue: 0.0,
    sat: 1.0,
    exposure: 0.85,
    contrast: 1.08,
  };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  window.addEventListener('resize', resize);

  // 8-second loop
  const LOOP_MS = 8000;
  let startTime = performance.now();
  let running = true;

  function render() {
    if (!running) return;
    const elapsed = (performance.now() - startTime) % LOOP_MS;
    const phase = elapsed / LOOP_MS;

    gl.uniform2f(U.u_res, canvas.width, canvas.height);
    gl.uniform1f(U.u_phase, phase);
    gl.uniform1f(U.u_seed, params.seed);
    gl.uniform3fv(U.u_c1, params.c1);
    gl.uniform3fv(U.u_c2, params.c2);
    gl.uniform3fv(U.u_c3, params.c3);
    gl.uniform3fv(U.u_c4, params.c4);
    gl.uniform3fv(U.u_bg, params.bg);
    gl.uniform1f(U.u_hue, params.hue);
    gl.uniform1f(U.u_sat, params.sat);
    gl.uniform1f(U.u_exposure, params.exposure);
    gl.uniform1f(U.u_contrast, params.contrast);
    gl.uniform1f(U.u_scale, params.scale);
    gl.uniform1f(U.u_complex, params.complex);
    gl.uniform1f(U.u_warp, params.warp);
    gl.uniform1f(U.u_flow, params.flow);
    gl.uniform1f(U.u_stretch, params.stretch);
    gl.uniform1f(U.u_light, params.light);
    gl.uniform1f(U.u_gloss, params.gloss);
    gl.uniform1f(U.u_lightAngle, params.lightAngle);
    gl.uniform1f(U.u_irid, params.irid);
    gl.uniform1f(U.u_glow, params.glow);
    gl.uniform1f(U.u_grain, params.grain);
    gl.uniform1f(U.u_ca, params.ca);
    gl.uniform1f(U.u_vig, params.vig);
    gl.uniform1f(U.u_travel, params.travel);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(render);
  }

  // Pause on hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      running = false;
    } else {
      running = true;
      startTime = performance.now() - (performance.now() % LOOP_MS);
      render();
    }
  });

  // Respect reduced motion
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    render();
  }
})();
