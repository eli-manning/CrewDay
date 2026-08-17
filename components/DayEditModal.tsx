import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, TextInput, ScrollView, StyleSheet } from 'react-native';
import { format, parseISO } from 'date-fns';
import { Ionicons } from '@expo/vector-icons';
import { fonts } from '../lib/theme';
import { useTheme } from '../context/ThemeContext';
import { DayEntry, UserProfile } from '../lib/types';

type Theme = ReturnType<typeof useTheme>['theme'];

interface DayEditModalProps {
  visible: boolean;
  date: string; // "YYYY-MM-DD"
  entry: DayEntry | undefined;
  profile: UserProfile;
  readOnly: boolean;
  saving: boolean;
  onSave: (patch: Partial<DayEntry>) => void;
  onClose: () => void;
}

function StatRow({ theme, label, value, done }: { theme: Theme; label: string; value: string; done: boolean }) {
  return (
    <View style={styles.statRow}>
      <Text style={[styles.statLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.statValue, { color: done ? theme.green : theme.text }]}>{value}</Text>
    </View>
  );
}

function CheckToggle({ theme, checked, onToggle, label }: { theme: Theme; checked: boolean; onToggle: () => void; label: string }) {
  return (
    <TouchableOpacity onPress={onToggle} style={styles.checkboxRow}>
      <View style={[
        styles.checkbox,
        { borderColor: theme.textMuted },
        checked && { borderColor: theme.accent, backgroundColor: theme.accentLight },
      ]}>
        {checked && <Text style={[styles.checkmark, { color: theme.accent }]}>X</Text>}
      </View>
      <Text style={[styles.checkboxLabel, { color: theme.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function NumberField({ theme, value, onChangeText, suffix }: { theme: Theme; value: string; onChangeText: (v: string) => void; suffix: string }) {
  return (
    <View style={styles.numberFieldRow}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType="numeric"
        style={[styles.numberInput, { borderColor: theme.border, backgroundColor: theme.surface2, color: theme.text }]}
        placeholderTextColor={theme.textMuted}
      />
      <Text style={[styles.numberSuffix, { color: theme.textMuted }]}>{suffix}</Text>
    </View>
  );
}

function EditRow({
  theme, label, done, onToggle, children,
}: { theme: Theme; label: string; done: boolean; onToggle: () => void; children?: React.ReactNode }) {
  return (
    <View style={[styles.editRow, { borderColor: theme.border, backgroundColor: theme.surface2 }]}>
      <CheckToggle theme={theme} checked={done} onToggle={onToggle} label={label} />
      {children && <View style={styles.editRowChildren}>{children}</View>}
    </View>
  );
}

function RatingRow({ theme, label, value, onChange }: { theme: Theme; label: string; value?: number; onChange: (v: number | undefined) => void }) {
  return (
    <View style={styles.inputGroup}>
      <Text style={[styles.inputLabel, { color: theme.textMuted }]}>{label}</Text>
      <View style={styles.ratingRow}>
        {[1, 2, 3, 4, 5].map((n) => (
          <TouchableOpacity
            key={n}
            onPress={() => onChange(value === n ? undefined : n)}
            style={[
              styles.ratingPip,
              { borderColor: theme.border, backgroundColor: theme.surface2 },
              value === n && { borderColor: theme.accent, backgroundColor: theme.accentLight },
            ]}
          >
            <Text style={[styles.ratingPipText, { color: value === n ? theme.accent : theme.textMuted }]}>{n}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export function DayEditModal({ visible, date, entry, profile, readOnly, saving, onSave, onClose }: DayEditModalProps) {
  const { theme } = useTheme();
  const [mode, setMode] = useState<'view' | 'edit'>('view');

  const [w1Done, setW1Done] = useState(false);
  const [w1Mins, setW1Mins] = useState('45');
  const [w2Done, setW2Done] = useState(false);
  const [w2Mins, setW2Mins] = useState('45');
  const [w2Outdoor, setW2Outdoor] = useState(false);
  const [dietDone, setDietDone] = useState(false);
  const [waterDone, setWaterDone] = useState(false);
  const [waterOz, setWaterOz] = useState('0');
  const [readDone, setReadDone] = useState(false);
  const [pages, setPages] = useState('0');
  const [photoDone, setPhotoDone] = useState(false);
  const [weight, setWeight] = useState('');
  const [mood, setMood] = useState<number | undefined>(undefined);
  const [energy, setEnergy] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!visible) return;
    setMode('view');
    setW1Done(entry?.workoutOneCompleted ?? false);
    setW1Mins(String(entry?.workoutOneDuration ?? 45));
    setW2Done(entry?.workoutTwoCompleted ?? false);
    setW2Mins(String(entry?.workoutTwoDuration ?? 45));
    setW2Outdoor(entry?.workoutTwoOutdoor ?? false);
    setDietDone(entry?.dietCompleted ?? false);
    setWaterDone(entry?.waterCompleted ?? false);
    setWaterOz(String(entry?.waterOzLogged ?? 0));
    setReadDone(entry?.readingCompleted ?? false);
    setPages(String(entry?.pagesRead ?? 0));
    setPhotoDone(entry?.photoCompleted ?? false);
    setWeight(entry?.bodyWeight != null ? String(entry.bodyWeight) : '');
    setMood(entry?.mood);
    setEnergy(entry?.energyLevel);
  }, [visible, entry, date]);

  if (!visible) return null;

  function handleSave() {
    const mins1 = parseInt(w1Mins, 10);
    const mins2 = parseInt(w2Mins, 10);
    const oz = parseInt(waterOz, 10);
    const pg = parseInt(pages, 10);
    const wt = parseFloat(weight);
    onSave({
      workoutOneCompleted: w1Done,
      workoutOneDuration: isNaN(mins1) ? 0 : mins1,
      workoutTwoCompleted: w2Done,
      workoutTwoDuration: isNaN(mins2) ? 0 : mins2,
      workoutTwoOutdoor: w2Outdoor,
      dietCompleted: dietDone,
      waterCompleted: waterDone,
      waterOzLogged: isNaN(oz) ? 0 : oz,
      readingCompleted: readDone,
      pagesRead: isNaN(pg) ? 0 : pg,
      photoCompleted: photoDone,
      bodyWeight: weight.trim() === '' || isNaN(wt) ? undefined : wt,
      mood,
      energyLevel: energy,
    });
  }

  const dateLabel = format(parseISO(date), 'EEEE, MMM d').toUpperCase();
  const isGeneral = profile.challengeMode === 'general';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.accent }]}>
          <View style={styles.headerRow}>
            <Text style={[styles.heading, { color: theme.accent }]}>{dateLabel}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={20} color={theme.textMuted} />
            </TouchableOpacity>
          </View>

          {!entry && mode === 'view' ? (
            <Text style={[styles.body, { color: theme.textMuted }]}>No data logged for this day.</Text>
          ) : (
            <ScrollView style={styles.formScroll} showsVerticalScrollIndicator={false}>
              <View style={styles.form}>
                {mode === 'view' ? (
                  <>
                    <StatRow theme={theme} label="WORKOUT 1" value={w1Done ? `${w1Mins} MIN` : '—'} done={w1Done} />
                    <StatRow theme={theme} label="WORKOUT 2" value={w2Done ? `${w2Mins} MIN${w2Outdoor ? ' · OUTDOOR' : ''}` : '—'} done={w2Done} />
                    <StatRow theme={theme} label="DIET" value={dietDone ? 'FOLLOWED' : '—'} done={dietDone} />
                    <StatRow theme={theme} label="WATER" value={`${waterOz}OZ`} done={waterDone} />
                    <StatRow theme={theme} label="READING" value={`${pages} PAGES`} done={readDone} />
                    <StatRow theme={theme} label="PHOTO" value={photoDone ? 'TAKEN' : '—'} done={photoDone} />
                    {weight.trim() !== '' && <StatRow theme={theme} label="WEIGHT" value={`${weight} ${profile.weightUnit ?? 'lbs'}`} done />}
                    {mood != null && <StatRow theme={theme} label="MOOD" value={`${mood}/5`} done />}
                    {energy != null && <StatRow theme={theme} label="ENERGY" value={`${energy}/5`} done />}
                    {entry?.dailyPoints != null && (
                      <StatRow theme={theme} label="POINTS" value={String(entry.dailyPoints)} done={!!entry.allCoreCompleted} />
                    )}
                  </>
                ) : (
                  <>
                    <EditRow theme={theme} label="WORKOUT 1" done={w1Done} onToggle={() => setW1Done((v) => !v)}>
                      <NumberField theme={theme} value={w1Mins} onChangeText={setW1Mins} suffix="MIN" />
                    </EditRow>
                    <EditRow theme={theme} label="WORKOUT 2" done={w2Done} onToggle={() => setW2Done((v) => !v)}>
                      <NumberField theme={theme} value={w2Mins} onChangeText={setW2Mins} suffix="MIN" />
                      <CheckToggle theme={theme} checked={w2Outdoor} onToggle={() => setW2Outdoor((v) => !v)} label={`OUTDOOR${!isGeneral ? ' (REQUIRED)' : ''}`} />
                    </EditRow>
                    <EditRow theme={theme} label="DIET FOLLOWED" done={dietDone} onToggle={() => setDietDone((v) => !v)} />
                    <EditRow theme={theme} label="WATER" done={waterDone} onToggle={() => setWaterDone((v) => !v)}>
                      <NumberField theme={theme} value={waterOz} onChangeText={setWaterOz} suffix="OZ" />
                    </EditRow>
                    <EditRow theme={theme} label="READING" done={readDone} onToggle={() => setReadDone((v) => !v)}>
                      <NumberField theme={theme} value={pages} onChangeText={setPages} suffix="PAGES" />
                    </EditRow>
                    <EditRow theme={theme} label="PROGRESS PHOTO" done={photoDone} onToggle={() => setPhotoDone((v) => !v)} />
                    <View style={styles.inputGroup}>
                      <Text style={[styles.inputLabel, { color: theme.textMuted }]}>BODY WEIGHT ({profile.weightUnit ?? 'lbs'})</Text>
                      <TextInput
                        value={weight}
                        onChangeText={setWeight}
                        keyboardType="numeric"
                        style={[styles.textInput, { borderColor: theme.border, backgroundColor: theme.surface2, color: theme.text }]}
                        placeholder="—"
                        placeholderTextColor={theme.textMuted}
                      />
                    </View>
                    <RatingRow theme={theme} label="MOOD (1-5)" value={mood} onChange={setMood} />
                    <RatingRow theme={theme} label="ENERGY (1-5)" value={energy} onChange={setEnergy} />
                  </>
                )}
              </View>
            </ScrollView>
          )}

          {!readOnly && (
            mode === 'view' ? (
              <TouchableOpacity onPress={() => setMode('edit')} style={[styles.actionBtn, { backgroundColor: theme.accent }]}>
                <Text style={[styles.actionBtnText, { color: theme.white }]}>EDIT DAY</Text>
              </TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity onPress={handleSave} disabled={saving} style={[styles.actionBtn, { backgroundColor: theme.accent, opacity: saving ? 0.6 : 1 }]}>
                  <Text style={[styles.actionBtnText, { color: theme.white }]}>{saving ? 'SAVING…' : 'SAVE'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setMode('view')} disabled={saving} style={styles.backBtn}>
                  <Text style={[styles.backBtnText, { color: theme.textMuted }]}>CANCEL</Text>
                </TouchableOpacity>
              </>
            )
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    borderWidth: 2,
    padding: 24,
    width: '100%',
    maxWidth: 432,
    gap: 14,
    maxHeight: '85%',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: {
    fontFamily: fonts.pixel,
    fontSize: 9,
    lineHeight: 16,
    flexShrink: 1,
  },
  body: {
    fontFamily: fonts.pixel,
    fontSize: 6,
    lineHeight: 12,
  },
  formScroll: { maxHeight: 420 },
  form: { gap: 12 },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  statLabel: { fontFamily: fonts.pixel, fontSize: 6 },
  statValue: { fontFamily: fonts.vt323, fontSize: 18 },
  editRow: { borderWidth: 1, padding: 10, gap: 8 },
  editRowChildren: { gap: 8, paddingLeft: 28 },
  inputGroup: { gap: 6 },
  inputLabel: { fontFamily: fonts.pixel, fontSize: 6 },
  textInput: {
    fontFamily: fonts.vt323,
    fontSize: 22,
    borderWidth: 2,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  numberFieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  numberInput: {
    fontFamily: fonts.vt323,
    fontSize: 20,
    borderWidth: 2,
    paddingHorizontal: 10,
    paddingVertical: 6,
    width: 90,
  },
  numberSuffix: { fontFamily: fonts.pixel, fontSize: 6 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  checkbox: {
    width: 16,
    height: 16,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmark: { fontFamily: fonts.pixel, fontSize: 7 },
  checkboxLabel: { fontFamily: fonts.pixel, fontSize: 6, flex: 1, lineHeight: 12 },
  ratingRow: { flexDirection: 'row', gap: 8 },
  ratingPip: {
    width: 32, height: 32,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ratingPipText: { fontFamily: fonts.pixel, fontSize: 8 },
  actionBtn: { paddingVertical: 14, alignItems: 'center' },
  actionBtnText: { fontFamily: fonts.pixel, fontSize: 9 },
  backBtn: { alignItems: 'center', paddingVertical: 8 },
  backBtnText: { fontFamily: fonts.pixel, fontSize: 6 },
});
