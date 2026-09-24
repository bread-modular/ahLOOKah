// Numeric parameter scales — one place that knows how a value maps onto a track.
//
// Most parameters are linear over their domain. A parameter declared with
// `scale: 'log'` is logarithmic, which is what makes a wide range of durations
// usable: on a 0.1 s … 10 s track, half the travel sits below about 1 s instead of
// squeezing every fast cycle into the first few pixels.
//
// The slider thumb, the mapping overlay's box/handles/LIVE marker, the mapping
// drag gestures and the value quantizer all go through these helpers, so a value
// and its position on the track can never disagree — whichever surface the
// operator is looking at.
export const scaleOf = def => def?.scale === 'log' ? 'log' : 'linear';

// Track space is what a native range input (or a 0…100 % overlay position) uses:
// the value itself when linear, its base-10 logarithm when logarithmic.
export const trackValue = (value, def) => {
  const finite = Number.isFinite(value) ? value : def?.default ?? def?.min;
  // A log domain is positive by definition: a value at or below zero has no
  // position, so it is pinned to the domain floor for *display* only.
  return scaleOf(def) === 'log' ? Math.log10(Math.max(def.min, finite)) : finite;
};
export const trackMin = def => trackValue(def.min, def);
export const trackMax = def => trackValue(def.max, def);
export const valueAtTrack = (track, def) => scaleOf(def) === 'log' ? 10 ** track : track;

// Fraction of the track a value sits at (0…1, unclamped) and its inverse. Display
// positions clamp; gestures use the unclamped pair so an endpoint can be dragged
// past the edge of the domain exactly as it could before log scales existed.
export const trackFraction = (value, def) => {
  const span = trackMax(def) - trackMin(def);
  return span > 0 ? (trackValue(value, def) - trackMin(def)) / span : 0;
};
export const valueAtFraction = (fraction, def) => valueAtTrack(trackMin(def) + fraction * (trackMax(def) - trackMin(def)), def);
export const percentOf = (value, def) => 100 * Math.min(1, Math.max(0, trackFraction(value, def)));

// The one value quantizer. Linear domains snap to `step`; a log domain snaps to
// `step` in decades and keeps four significant digits, so a stored duration reads
// as 250 ms or 2.512 s instead of a long binary fraction.
export function quantize(value, def) {
  const step = def?.step ?? 0.01;
  if (!(step > 0)) return value;
  if (scaleOf(def) === 'log') return Number((10 ** (Math.round(Math.log10(value) / step) * step)).toPrecision(4));
  return Math.round(value / step) * step;
}
