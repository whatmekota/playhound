import type { VrEye, VrLayout } from './vrFormat'

/**
 * Drawing a VR video on a sphere seen from inside: the shader works out, for
 * each direction, where it lands in one eye's part of the frame. Shared by
 * the VR view on a screen (components/player/SbsViewer.vue) and the headset
 * player (lib/xrScene.ts), which draws one sphere per eye.
 */

export const VR_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

/**
 * Where a direction lands in one eye's part of the frame (eyeRect: x, y, w, h
 * in texture coordinates).
 *   equirect: longitude across the field of view, latitude over 180°
 *   fisheye:  equidistant, the angle off centre grows evenly to the rim
 */
export const VR_FRAG = /* glsl */`
uniform sampler2D map;
uniform float halfFov;
uniform bool fisheye;
uniform vec4 eyeRect;
varying vec3 vDir;
const float PI = 3.14159265358979;
void main() {
  vec3 d = normalize(vDir);
  vec2 uv;
  if (fisheye) {
    float theta = acos(clamp(-d.z, -1.0, 1.0));
    if (theta > halfFov) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float r = 0.5 * theta / halfFov;
    float phi = atan(d.y, d.x);
    uv = vec2(0.5 + r * cos(phi), 0.5 + r * sin(phi));
  }
  else {
    float lon = atan(d.x, -d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    if (abs(lon) > halfFov) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    uv = vec2(0.5 + 0.5 * lon / halfFov, 0.5 + lat / PI);
  }
  gl_FragColor = texture2D(map, eyeRect.xy + uv * eyeRect.zw);
}`

/**
 * One eye's part of the frame, in texture coordinates (v runs bottom to top,
 * so the top half is 0.5–1): side by side, top (left eye) over bottom, or the
 * whole frame for both.
 */
export function eyeRect(layout: VrLayout, eye: VrEye): [number, number, number, number] {
  const right = eye === 'right'
  if (layout === 'tb')
    return [0, right ? 0 : 0.5, 1, 0.5]
  if (layout === 'mono')
    return [0, 0, 1, 1]
  return [right ? 0.5 : 0, 0, 0.5, 1]
}
