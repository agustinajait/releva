import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { login, type MobileUser } from '../services/api';
import { C, s } from './theme';

export function LoginScreen({ onLogin }: { onLogin: (u: MobileUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(email.trim(), password));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={[s.screen, { justifyContent: 'center' }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[s.pad, { gap: 16 }]}>
        <Text style={{ color: C.accent, fontSize: 40, fontWeight: '800', letterSpacing: 6 }}>RELEVA</Text>
        <Text style={s.muted}>Relevamiento territorial asistido por voz</Text>
        <TextInput
          style={s.input}
          placeholder="Email"
          placeholderTextColor={C.text3}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          value={email}
          onChangeText={setEmail}
          accessibilityLabel="Email"
        />
        <TextInput
          style={s.input}
          placeholder="Contraseña"
          placeholderTextColor={C.text3}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          accessibilityLabel="Contraseña"
        />
        {error && <Text style={s.error}>{error}</Text>}
        <Pressable style={[s.btn, s.btnPrimary, busy && s.btnDisabled]} onPress={submit} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color={C.accentInk} /> : <Text style={s.btnPrimaryText}>Ingresar</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
