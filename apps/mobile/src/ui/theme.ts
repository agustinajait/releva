import { StyleSheet } from 'react-native';

/** Tema oscuro de alto contraste: se usa de noche, dentro de un vehículo. */
export const C = {
  bg: '#0c1717',
  panel: '#132425',
  panel2: '#1a3132',
  line: '#27413f',
  text: '#eef5f4',
  text2: '#a9bfbd',
  text3: '#6f8a88',
  accent: '#f5b942',
  accentInk: '#2b1d00',
  ok: '#4ade80',
  warn: '#fbbf24',
  danger: '#f87171',
  info: '#7dd3fc',
};

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  pad: { padding: 16, gap: 12 },
  h1: { color: C.text, fontSize: 26, fontWeight: '700' },
  h2: { color: C.text, fontSize: 18, fontWeight: '700' },
  label: { color: C.text3, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  text: { color: C.text, fontSize: 16 },
  muted: { color: C.text2, fontSize: 14 },
  card: { backgroundColor: C.panel, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.line, gap: 6 },
  input: { backgroundColor: C.panel2, color: C.text, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, borderWidth: 1, borderColor: C.line },
  btn: { backgroundColor: C.panel2, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', borderWidth: 1, borderColor: C.line },
  btnText: { color: C.text, fontSize: 16, fontWeight: '700' },
  btnPrimary: { backgroundColor: C.accent, borderColor: C.accent },
  btnPrimaryText: { color: C.accentInk, fontSize: 18, fontWeight: '800' },
  btnDisabled: { opacity: 0.4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  error: { color: C.danger, fontSize: 14, fontWeight: '600' },
});
