// Where in the log each board was sawn from.
//
// Log space: z runs up the trunk (the grain), the pith wanders near x = y = 0.
// A board's local frame (x along its length, y across its width, z through
// its thickness) is mapped into log space by an affine frame. Flat-sawn boards
// lie tangent to the rings and show cathedral figure; quarter-sawn boards lie
// along a radius and show straight grain (and ray fleck in oak), which is why
// coopers use them for staves.

export function logFrame(R, cut = 'flat') {
  const phi = R.range(0, Math.PI * 2);
  const er = [Math.cos(phi), Math.sin(phi), 0], et = [-Math.sin(phi), Math.cos(phi), 0];
  const flip = R.chance(0.5) ? 1 : -1;
  // a little grain runout: the saw never quite follows the tree
  const run = [R.sym(0.035), R.sym(0.035)];
  const ax = [er[0] * run[0] + et[0] * run[1], er[1] * run[0] + et[1] * run[1], flip];
  let ay, az, dist;
  if (cut === 'quarter') { ay = er; az = et; dist = R.range(0.11, 0.24); }
  else if (cut === 'rift') { const a = R.range(0.5, 1.0); ay = [er[0] * Math.cos(a) + et[0] * Math.sin(a), er[1] * Math.cos(a) + et[1] * Math.sin(a), 0]; az = [-er[0] * Math.sin(a) + et[0] * Math.cos(a), -er[1] * Math.sin(a) + et[1] * Math.cos(a), 0]; dist = R.range(0.08, 0.2); }
  else { ay = et; az = R.chance(0.5) ? er : [-er[0], -er[1], 0]; dist = R.range(0.035, 0.15); }
  const o = [er[0] * dist + et[0] * R.sym(0.03), er[1] * dist + et[1] * R.sym(0.03), R.range(-400, 400)];
  return { o, ax, ay, az };
}
