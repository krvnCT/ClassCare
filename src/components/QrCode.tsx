/**
 * A QR code, drawn as one SVG path.
 *
 * `qrcode-generator` does the hard half — Reed-Solomon, masking, version
 * selection — and hands back a grid of booleans. This turns that grid into
 * something on screen.
 *
 * ## One path, not eleven thousand rects
 *
 * A code carrying a handout is around 105 modules square, which is 11,000
 * cells and about half of them dark. Emitting a `<Rect>` per dark module means
 * five thousand native views, and `react-native-svg` renders each one: the
 * screen takes seconds to appear and janks on every re-render.
 *
 * Every module is instead appended to a single path `d` string, so the whole
 * code is one node. Same pixels, one view.
 *
 * ## Always dark on white
 *
 * Deliberately not themed. A scanner is looking for dark modules on a light
 * ground, and the app's dark mode would otherwise render a dark code on a dark
 * card — which looks correct to a person and is invisible to a camera. The
 * white plate is part of the code, not decoration, and so is the quiet zone
 * around it: the spec asks for four modules of clear space and a scanner will
 * refuse a code pressed to the edge of its container.
 */
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { View, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

/** Clear space around the code, in modules. Four is the spec's minimum. */
const QUIET = 4;

export function QrCode({
  value,
  size,
  style,
}: {
  value: string;
  /** Rendered edge in points, quiet zone included. */
  size: number;
  style?: ViewStyle;
}) {
  const { path, edge } = useMemo(() => {
    /*
      Version 0 lets the library pick the smallest that fits, and `M` recovers
      15% of a damaged code. That is the right level for a screen held up in
      front of a class: `L` gives a smaller grid but no margin for a thumb
      across the corner or a reflection off the glass, and `Q` upwards grows
      the grid enough to cost more in scannability than the redundancy wins.
    */
    const qr = qrcode(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();

    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (!qr.isDark(row, col)) continue;
        // Drawn at unit scale and scaled by the viewBox, so nothing here has
        // to know how big the code is on screen.
        d += `M${col + QUIET} ${row + QUIET}h1v1h-1z`;
      }
    }
    return { path: d, edge: count + QUIET * 2 };
  }, [value]);

  return (
    <View
      style={[
        {
          width: size,
          height: size,
          backgroundColor: '#FFFFFF',
          borderRadius: 12,
          overflow: 'hidden',
        },
        style,
      ]}>
      <Svg width={size} height={size} viewBox={`0 0 ${edge} ${edge}`}>
        <Path d={path} fill="#000000" />
      </Svg>
    </View>
  );
}
