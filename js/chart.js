// One SVG bar chart, as a string. Pure, so it tests under Node and renders
// anywhere innerHTML does. Colors come from the page: bars use currentColor,
// the average line uses --accent, so both follow the theme.
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function barChart({ values = [], labels = [], line, width = 320, height = 120, format }) {
  const padTop = 6, padBottom = 18, padX = 4;
  const plotH = height - padTop - padBottom;
  const n = values.length;
  const max = Math.max(line || 0, ...values.map((v) => Number(v) || 0), 0);
  const scale = max > 0 ? plotH / max : 0;
  const slot = n ? (width - padX * 2) / n : 0;
  const barW = Math.max(2, slot * 0.6);
  const fmt = format || ((v) => String(v));
  let out = '';
  values.forEach((v, i) => {
    const h = Math.max(0, (Number(v) || 0) * scale);
    const x = padX + i * slot + (slot - barW) / 2;
    const y = padTop + plotH - h;
    out += '<rect class="bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"><title>' + esc(labels[i]) + ' ' + esc(fmt(v)) + '</title></rect>';
    out += '<text class="lbl" x="' + (x + barW / 2).toFixed(1) + '" y="' + (height - 4) + '" text-anchor="middle">' + esc(labels[i]) + '</text>';
  });
  // All-zero bars leave max at 0, and a line on that baseline would read as
  // data rather than an average of nothing, so it is left undrawn.
  if (line != null && max > 0) {
    const y = (padTop + plotH - (Number(line) || 0) * scale).toFixed(1);
    out += '<line class="avg" x1="' + padX + '" x2="' + (width - padX) + '" y1="' + y + '" y2="' + y + '"><title>average ' + esc(fmt(line)) + '</title></line>';
  }
  return '<svg class="chart" viewBox="0 0 ' + width + ' ' + height + '" width="100%" role="img" aria-label="bar chart">' +
    '<title>' + esc(values.map((v, i) => labels[i] + ' ' + fmt(v)).join(', ')) + '</title>' + out + '</svg>';
}
