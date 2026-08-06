// Geometry check: do adjacent pieces interlock (tab into notch) along every joint?
// Replicates the client's buildPath/edge functions and samples the curves.

const BOARD_W = 1000, BOARD_H = 1000;

function edgePoints(x1, y1, x2, y2, dir, k, vert, steps = 40) {
  const pts = [];
  if (dir === 0) {
    for (let i = 0; i <= steps; i++) pts.push([x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps]);
    return pts;
  }
  const kS = k, kN = k * 0.6;
  // Build the same path the canvas Path2D would have: lineTo + 2 bezierCurveTo + lineTo
  // We sample the polyline: start, lineTo1, bez1(end at mid), bez2, lineTo2(end)
  const seg = [];
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  if (!vert) {
    const oY = dir, dX = x2 > x1 ? 1 : -1;
    seg.push([x1, y1]);
    seg.push([mx - kS * dX, y1]);
    seg.push({ bez: [[mx - kN * dX, y1], [mx - kN * dX, y1 + kS * 1.2 * oY], [mx, y1 + kS * 1.3 * oY]] });
    seg.push({ bez: [[mx + kN * dX, y1 + kS * 1.2 * oY], [mx + kN * dX, y1], [mx + kS * dX, y1]] });
    seg.push([x2, y2]);
  } else {
    const oX = dir, dY = y2 > y1 ? 1 : -1;
    seg.push([x1, y1]);
    seg.push([x1, my - kS * dY]);
    seg.push({ bez: [[x1, my - kN * dY], [x1 + kS * 1.2 * oX, my - kN * dY], [x1 + kS * 1.3 * oX, my]] });
    seg.push({ bez: [[x1 + kS * 1.2 * oX, my + kN * dY], [x1, my + kN * dY], [x1, my + kS * dY]] });
    seg.push([x2, y2]);
  }
  for (const s of seg) {
    if (!s.bez) { pts.push(s); continue; }
    const [p0x, p0y] = pts[pts.length - 1];
    const [c1x, c1y] = s.bez[0], [c2x, c2y] = s.bez[1], [p1x, p1y] = s.bez[2];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      pts.push([
        u*u*u*p0x + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*p1x,
        u*u*u*p0y + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*p1y,
      ]);
    }
  }
  return pts;
}

// Returns the curve for each edge of piece (r,c), given joint values h[r][c] (horizontal joints below row r)
// and v[r][c] (vertical joints right of col c). Mirrors precomputePaths + buildPath exactly.
function pieceEdges(n, h, v, r, c, pw, ph) {
  const top = r === 0 ? 0 : -h[r - 1][c];
  const bot = h[r][c];
  const left = c === 0 ? 0 : v[r][c - 1];
  const right = v[r][c];
  const k = Math.min(pw, ph) * .22;
  return {
    top: edgePoints(0, 0, pw, 0, -top, k, false),
    right: edgePoints(pw, 0, pw, ph, right, k, true),
    bot: edgePoints(pw, ph, 0, ph, bot, k, false),
    left: edgePoints(0, ph, 0, 0, left, k, true),
    topV: top, botV: bot, leftV: left, rightV: right,
  };
}

// Distance from point to segment
function ptSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// How far does curve A deviate from curve B (avg + max distance)?
function curveDist(A, B) {
  let max = 0, sum = 0;
  for (const [px, py] of A) {
    let d = Infinity;
    for (let i = 0; i < B.length - 1; i++) d = Math.min(d, ptSegDist(px, py, B[i][0], B[i][1], B[i + 1][0], B[i + 1][1]));
    max = Math.max(max, d); sum += d;
  }
  return { avg: sum / A.length, max };
}

function check(n, seed = 1) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const h = [], v = [];
  for (let r = 0; r < n; r++) {
    h.push([]); v.push([]);
    for (let c = 0; c < n; c++) {
      h[r].push(r < n - 1 ? (rnd() < .5 ? 1 : -1) : 0);
      v[r].push(c < n - 1 ? (rnd() < .5 ? 1 : -1) : 0);
    }
  }
  const pw = BOARD_W / n, ph = BOARD_H / n;
  const edges = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) edges.push(pieceEdges(n, h, v, r, c, pw, ph));

  console.log(`--- ${n}x${n} (seed ${seed}) ---`);
  let bad = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const me = edges[r * n + c];
      // right neighbor (translate neighbor's left edge by +pw so both are in this piece's frame)
      if (c < n - 1) {
        const nb = edges[r * n + c + 1];
        const nbLeft = [...nb.left].reverse().map(([x, y]) => [x + pw, y]);
        const d = curveDist(me.right, nbLeft);
        if (d.max > 0.5) { console.log(`  [x] H joint (r=${r},c=${c}): me.right=${me.rightV} nb.left=${nb.leftV}  maxDev=${d.max.toFixed(2)}`); bad++; }
        else console.log(`  [ok] H joint (r=${r},c=${c}): me.right=${me.rightV} nb.left=${nb.leftV}  maxDev=${d.max.toFixed(3)}`);
      }
      // bottom neighbor (translate neighbor's top edge by +ph)
      if (r < n - 1) {
        const nb = edges[(r + 1) * n + c];
        const nbTop = [...nb.top].reverse().map(([x, y]) => [x, y + ph]);
        const d = curveDist(me.bot, nbTop);
        if (d.max > 0.5) { console.log(`  [x] V joint (r=${r},c=${c}): me.bot=${me.botV} nb.top=${nb.topV}  maxDev=${d.max.toFixed(2)}`); bad++; }
        else console.log(`  [ok] V joint (r=${r},c=${c}): me.bot=${me.botV} nb.top=${nb.topV}  maxDev=${d.max.toFixed(3)}`);
      }
    }
  }
  console.log(bad ? `  -> ${bad} MISFITTING joints!` : '  -> all joints fit perfectly');
  return bad;
}

let total = 0;
for (const n of [3, 4, 5, 6]) total += check(n, n * 7 + 1);
console.log(total === 0 ? '\nALL GRIDS OK' : `\n${total} MISFITS TOTAL`);
