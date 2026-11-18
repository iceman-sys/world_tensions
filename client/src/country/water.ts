import * as THREE from 'three';

const vertex = /* glsl */ `
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const fragment = /* glsl */ `
#include <fog_pars_fragment>
uniform float uTime;
uniform sampler2D uDepth;
uniform float uHalf;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform float uNight;
varying vec3 vWorld;

float wave(vec2 p, vec2 d, float f, float s) { return sin(dot(p, d) * f + uTime * s); }

void main() {
  vec2 p = vWorld.xz;
  // analytic gentle waves -> normal
  float e = 0.35;
  float hx = 0.0, hz = 0.0;
  hx += cos(dot(p, vec2(0.8, 0.6)) * 0.9 + uTime * 0.9) * 0.9 * 0.8;
  hz += cos(dot(p, vec2(0.8, 0.6)) * 0.9 + uTime * 0.9) * 0.9 * 0.6;
  hx += cos(dot(p, vec2(-0.3, 0.95)) * 1.7 + uTime * 1.3) * 1.7 * -0.3 * 0.5;
  hz += cos(dot(p, vec2(-0.3, 0.95)) * 1.7 + uTime * 1.3) * 1.7 * 0.95 * 0.5;
  // waves fade with distance so far water does not shimmer (moire)
  float far = 1.0 - smoothstep(60.0, 220.0, distance(cameraPosition, vWorld));
  vec3 n = normalize(vec3(-hx * 0.06 * e * far, 1.0, -hz * 0.06 * e * far));

  // depth from the terrain (shallow near shores); outside the terrain area it is deep
  vec2 uv = vec2(p.x / (2.0 * uHalf) + 0.5, -p.y / (2.0 * uHalf) + 0.5);
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  float depth = mix(1.0, texture2D(uDepth, clamp(uv, 0.0, 1.0)).r, inside);
  vec3 base = mix(uShallow, uDeep, smoothstep(0.05, 0.8, depth));

  vec3 V = normalize(cameraPosition - vWorld);
  float diff = max(dot(n, uSunDir), 0.0);
  float spec = pow(max(dot(reflect(-uSunDir, n), V), 0.0), 80.0) * far;
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  vec3 col = base * (0.55 + 0.45 * diff) * mix(1.0, 0.35, uNight);
  col += uSunColor * spec * 0.6 * (1.0 - uNight);
  col = mix(col, vec3(0.62, 0.74, 0.86) * mix(1.0, 0.25, uNight), fres * 0.35);
  // foam where the water is very shallow
  float foam = (1.0 - smoothstep(0.0, 0.07, depth)) * inside * (0.6 + 0.4 * wave(p, vec2(0.7, 0.7), 2.3, 1.7));
  col = mix(col, vec3(0.92, 0.95, 0.97), clamp(foam, 0.0, 1.0) * 0.55);
  // shallow water is see-through, deep water is opaque (hides the seabed edge)
  gl_FragColor = vec4(col, mix(0.72, 1.0, smoothstep(0.08, 0.45, depth)));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface WaterUniforms {
  uTime: THREE.IUniform<number>;
  uNight: THREE.IUniform<number>;
}

/** Large animated water plane at y = 0 with shore shading from a depth texture. */
export function buildWater(depth: THREE.DataTexture, halfSize: number, sunDir: THREE.Vector3): { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>; uniforms: WaterUniforms } {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  const own = {
    uTime: { value: 0 },
    uNight: { value: 0 },
    uDepth: { value: depth },
    uHalf: { value: halfSize },
    uSunDir: { value: sunDir },
    uSunColor: { value: new THREE.Color('#fff2d8') },
    uShallow: { value: new THREE.Color('#3fa7b8') },
    uDeep: { value: new THREE.Color('#14466b') },
  };
  Object.assign(uniforms, own);
  const mat = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms, fog: true, transparent: true, depthWrite: false });
  const geo = new THREE.PlaneGeometry(halfSize * 8, halfSize * 8, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.02;
  mesh.renderOrder = 1;
  return { mesh, uniforms: own };
}
