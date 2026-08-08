import React, { useState, useEffect, useMemo, Fragment } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Dimensions,
} from 'react-native';
import Svg, { Line, Rect, Path, Circle, Text as SvgText } from 'react-native-svg';
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval, getDay,
  parseISO, isToday, isFuture, subDays, addDays,
} from 'date-fns';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../hooks/useAuth';
import { useAllUsers } from '../../hooks/useAllUsers';
import { getDayHistory, getUserProfile } from '../../lib/firestore';
import { computeStreakFromHistory } from '../../lib/points';
import { DayEntry, UserProfile } from '../../lib/types';
import { getSessionCached } from '../../lib/cache';
import { fonts } from '../../lib/theme';
import { useTheme } from '../../context/ThemeContext';
import { LoadingScreen } from '../../components/LoadingScreen';
import { useHideNavWhileLoading } from '../../context/NavVisibilityContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const SCREEN_W = Dimensions.get('window').width;
const CHART_W = SCREEN_W - 64;
const CHART_H = 160;

type Theme = ReturnType<typeof useTheme>['theme'];

function tileColor(entry: DayEntry | undefined, date: Date, startDate: string | null, theme: Theme): string {
  if (isFuture(date) && !isToday(date)) return theme.surface;
  if (isToday(date) && (!entry || !entry.allCoreCompleted)) return theme.accentLight;
  if (!entry && (!startDate || format(date, 'yyyy-MM-dd') <= startDate)) return theme.surface;
  if (!entry) return theme.redLight;
  if (entry.allCoreCompleted) return theme.greenLight;
  const done = [
    entry.workoutOneCompleted, entry.workoutTwoCompleted && entry.workoutTwoOutdoor,
    entry.dietCompleted, entry.waterCompleted, entry.readingCompleted, entry.photoCompleted,
  ].filter(Boolean).length;
  if (done === 0) return isToday(date) ? theme.accentLight : theme.redLight;
  return theme.yellowLight;
}

function tileBorder(entry: DayEntry | undefined, date: Date, startDate: string | null, theme: Theme): string {
  if (isFuture(date) && !isToday(date)) return theme.border;
  if (isToday(date) && (!entry || !entry.allCoreCompleted)) return theme.accent;
  if (!entry && (!startDate || format(date, 'yyyy-MM-dd') <= startDate)) return theme.border;
  if (!entry) return theme.red;
  if (entry.allCoreCompleted) return theme.green;
  const done = [
    entry.workoutOneCompleted, entry.workoutTwoCompleted && entry.workoutTwoOutdoor,
    entry.dietCompleted, entry.waterCompleted, entry.readingCompleted, entry.photoCompleted,
  ].filter(Boolean).length;
  if (done === 0) return isToday(date) ? theme.accent : theme.red;
  return theme.yellowLight;
}

// ── Simple SVG bar chart ───────────────────────────────────────────────────────

function BarChart({
  data, color, goalY, goalColor, goalBorderColor, label,
}: {
  data: { x: string; y: number }[];
  color: string;
  goalY?: number;
  goalColor?: string;
  goalBorderColor?: string;
  label?: string;
}) {
  const { theme } = useTheme();
  if (data.length === 0) return null;
  const maxY = Math.max(...data.map((d) => d.y), goalY ?? 0, 1);
  const barW = Math.max(2, (CHART_W - 30) / data.length - 2);
  const padLeft = 28;
  const padBottom = 20;
  const chartH = CHART_H - padBottom;

  return (
    <Svg width={CHART_W} height={CHART_H}>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <Line
          key={f}
          x1={padLeft} y1={chartH * (1 - f)}
          x2={CHART_W} y2={chartH * (1 - f)}
          stroke="rgba(26,32,48,0.18)" strokeWidth={1} strokeDasharray="3,3"
        />
      ))}
      <Line x1={padLeft} y1={chartH} x2={CHART_W} y2={chartH} stroke="rgba(26,32,48,0.35)" strokeWidth={1} />
      <SvgText x={padLeft - 4} y={chartH} fill={theme.textMuted} fontSize={8} textAnchor="end" fontFamily="Inter">0</SvgText>
      <SvgText x={padLeft - 4} y={chartH * 0.5} fill={theme.textMuted} fontSize={8} textAnchor="end" fontFamily="Inter">{Math.round(maxY / 2)}</SvgText>
      <SvgText x={padLeft - 4} y={8} fill={theme.textMuted} fontSize={8} textAnchor="end" fontFamily="Inter">{Math.round(maxY)}</SvgText>
      {data.map((d, i) => {
        const x = padLeft + i * ((CHART_W - padLeft) / data.length) + 1;
        const h = Math.max(1, (d.y / maxY) * chartH);
        return <Rect key={i} x={x} y={chartH - h} width={barW} height={h} fill={color} />;
      })}
      {goalY !== undefined && goalBorderColor && (
        <Line
          x1={padLeft} y1={chartH - (goalY / maxY) * chartH}
          x2={CHART_W} y2={chartH - (goalY / maxY) * chartH}
          stroke={goalBorderColor} strokeWidth={3.5} strokeDasharray="4,4"
        />
      )}
      {goalY !== undefined && (
        <Line
          x1={padLeft} y1={chartH - (goalY / maxY) * chartH}
          x2={CHART_W} y2={chartH - (goalY / maxY) * chartH}
          stroke={goalColor ?? theme.green} strokeWidth={1.5} strokeDasharray="4,4"
        />
      )}
      {data.length > 0 && (
        <>
          <SvgText x={padLeft + 2} y={CHART_H} fill={theme.textMuted} fontSize={8} fontFamily="Inter">{data[0].x}</SvgText>
          <SvgText x={CHART_W - 4} y={CHART_H} fill={theme.textMuted} fontSize={8} textAnchor="end" fontFamily="Inter">{data[data.length - 1].x}</SvgText>
        </>
      )}
    </Svg>
  );
}

function LineChartSvg({
  datasets, goalY, goalColor,
}: {
  datasets: { data: { x: string; y: number }[]; color: string; dashed?: boolean }[];
  goalY?: number;
  goalColor?: string;
}) {
  const { theme } = useTheme();
  const allValues = datasets.flatMap((ds) => ds.data.map((d) => d.y));
  if (allValues.length === 0) return null;
  const maxY = Math.max(...allValues, goalY ?? 0, 1);
  const minY = Math.min(...allValues, 0);
  const range = maxY - minY || 1;
  const padLeft = 28;
  const padBottom = 20;
  const chartH = CHART_H - padBottom;
  const maxLen = Math.max(...datasets.map((ds) => ds.data.length));

  function toPath(data: { x: string; y: number }[]): string {
    if (data.length === 0) return '';
    const divisor = maxLen > 1 ? maxLen - 1 : 1;
    return data.map((d, i) => {
      const x = padLeft + (i / divisor) * (CHART_W - padLeft);
      const y = chartH - ((d.y - minY) / range) * chartH;
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    }).join(' ');
  }

  return (
    <Svg width={CHART_W} height={CHART_H}>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <Line key={f} x1={padLeft} y1={chartH * (1 - f)} x2={CHART_W} y2={chartH * (1 - f)} stroke="rgba(26,32,48,0.18)" strokeWidth={1} strokeDasharray="3,3" />
      ))}
      <Line x1={padLeft} y1={chartH} x2={CHART_W} y2={chartH} stroke="rgba(26,32,48,0.35)" strokeWidth={1} />
      <SvgText x={padLeft - 4} y={chartH} fill={theme.textMuted} fontSize={8} textAnchor="end" fontFamily="Inter">{Math.round(minY)}</SvgText>
      <SvgText x={padLeft - 4} y={8} fill={theme.textMuted} fontSize={8} textAnchor="end" fontFamily="Inter">{Math.round(maxY)}</SvgText>
      {goalY !== undefined && (
        <Line
          x1={padLeft} y1={chartH - ((goalY - minY) / range) * chartH}
          x2={CHART_W} y2={chartH - ((goalY - minY) / range) * chartH}
          stroke={goalColor ?? theme.green} strokeWidth={1.5} strokeDasharray="4,4"
        />
      )}
      {datasets.map((ds, di) => (
        <Path
          key={di}
          d={toPath(ds.data)}
          stroke={ds.color}
          strokeWidth={2.5}
          fill="none"
          strokeDasharray={ds.dashed ? '4,2' : undefined}
        />
      ))}
      {datasets[0]?.data.length > 0 && (
        <>
          <SvgText x={padLeft + 2} y={CHART_H} fill={theme.textMuted} fontSize={8} fontFamily="Inter">{datasets[0].data[0].x}</SvgText>
          <SvgText x={CHART_W - 4} y={CHART_H} fill={theme.textMuted} fontSize={8} textAnchor="end" fontFamily="Inter">{datasets[0].data[datasets[0].data.length - 1].x}</SvgText>
        </>
      )}
    </Svg>
  );
}

function StackedBarChart({ data }: { data: { x: string; w1: number; w2: number }[] }) {
  const { theme } = useTheme();
  if (data.length === 0) return null;
  const maxY = Math.max(...data.map((d) => d.w1 + d.w2), 1);
  const barW = Math.max(2, (CHART_W - 30) / data.length - 2);
  const padLeft = 28;
  const padBottom = 20;
  const chartH = CHART_H - padBottom;

  return (
    <Svg width={CHART_W} height={CHART_H}>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <Line key={f} x1={padLeft} y1={chartH * (1 - f)} x2={CHART_W} y2={chartH * (1 - f)} stroke="rgba(26,32,48,0.18)" strokeWidth={1} strokeDasharray="3,3" />
      ))}
      <Line x1={padLeft} y1={chartH} x2={CHART_W} y2={chartH} stroke="rgba(26,32,48,0.35)" strokeWidth={1} />
      {data.map((d, i) => {
        const x = padLeft + i * ((CHART_W - padLeft) / data.length) + 1;
        const h1 = (d.w1 / maxY) * chartH;
        const h2 = (d.w2 / maxY) * chartH;
        return (
          <Fragment key={i}>
            <Rect x={x} y={chartH - h1 - h2} width={barW} height={h1} fill="#7a8898" />
            <Rect x={x} y={chartH - h2} width={barW} height={h2} fill={theme.green} />
          </Fragment>
        );
      })}
      <SvgText x={padLeft - 4} y={chartH} fill={theme.textMuted} fontSize={8} textAnchor="end" fontFamily="Inter">0</SvgText>
      <SvgText x={padLeft - 4} y={8} fill={theme.textMuted} fontSize={8} textAnchor="end" fontFamily="Inter">{Math.round(maxY)}</SvgText>
      {data.length > 0 && (
        <>
          <SvgText x={padLeft + 2} y={CHART_H} fill={theme.textMuted} fontSize={8} fontFamily="Inter">{data[0].x}</SvgText>
          <SvgText x={CHART_W - 4} y={CHART_H} fill={theme.textMuted} fontSize={8} textAnchor="end" fontFamily="Inter">{data[data.length - 1].x}</SvgText>
        </>
      )}
    </Svg>
  );
}

// ── Chart card wrapper ─────────────────────────────────────────────────────────

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={[styles.chartCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Text style={[styles.chartTitle, { color: theme.textMuted }]}>{title}</Text>
      {children}
    </View>
  );
}

// ── Insights dashboard ─────────────────────────────────────────────────────────

function InsightsDashboard({ history, viewProfile }: { history: DayEntry[]; viewProfile: UserProfile | undefined }) {
  const { theme } = useTheme();
  const today = format(new Date(), 'yyyy-MM-dd');
  const pastHistory = useMemo(
    () => history.filter((e) => !isFuture(parseISO(e.date)) && e.date !== today),
    [history, today]
  );
  const sorted = useMemo(() => [...pastHistory].sort((a, b) => a.date.localeCompare(b.date)), [pastHistory]);

  const startDate = viewProfile?.challengeStartDate;
  const daysSinceStart = startDate ? Math.floor((Date.now() - parseISO(startDate).getTime()) / 86400000) + 1 : 0;
  const challengeDay = Math.max(0, daysSinceStart);
  const challengePct = Math.min(100, (challengeDay / 75) * 100);
  const completedDays = pastHistory.filter((e) => e.allCoreCompleted).length;

  const last30 = useMemo(() => { const c = format(subDays(new Date(), 30), 'yyyy-MM-dd'); return sorted.filter((e) => e.date >= c); }, [sorted]);
  const last14 = useMemo(() => { const c = format(subDays(new Date(), 14), 'yyyy-MM-dd'); return sorted.filter((e) => e.date >= c); }, [sorted]);

  const waterData = last30.map((e) => ({ x: format(parseISO(e.date), 'M/d'), y: e.waterOzLogged }));
  const workoutData = last14.map((e) => ({
    x: format(parseISO(e.date), 'M/d'),
    w1: e.workoutOneCompleted ? (e.workoutOneDuration || 0) : 0,
    w2: (e.workoutTwoCompleted && e.workoutTwoOutdoor) ? (e.workoutTwoDuration || 0) : 0,
  }));
  const readingData = last30.map((e) => ({ x: format(parseISO(e.date), 'M/d'), y: e.pagesRead }));
  const weightEntries = sorted.filter((e) => e.bodyWeight != null && e.bodyWeight! > 0);
  const weightData = weightEntries.map((e) => ({ x: format(parseISO(e.date), 'M/d'), y: e.bodyWeight! }));
  const weightUnit = viewProfile?.weightUnit ?? 'lbs';
  const startingWeight = viewProfile?.startingWeight;
  const latestWeight = weightData.length > 0 ? weightData[weightData.length - 1].y : null;
  const weightChange = latestWeight != null && startingWeight != null ? (latestWeight - startingWeight) : null;

  const moodEntries = last30.filter((e) => e.mood != null);
  const moodData = moodEntries.map((e) => ({ x: format(parseISO(e.date), 'M/d'), y: e.mood! }));
  const energyData = moodEntries.map((e) => ({ x: format(parseISO(e.date), 'M/d'), y: e.energyLevel ?? 0 }));

  const taskBreakdown = useMemo(() => {
    const n = pastHistory.length;
    if (n === 0) return [];
    return [
      { name: 'WORKOUT 1', pct: Math.round((pastHistory.filter((e) => e.workoutOneCompleted).length / n) * 100) },
      { name: 'WORKOUT 2', pct: Math.round((pastHistory.filter((e) => e.workoutTwoCompleted && e.workoutTwoOutdoor).length / n) * 100) },
      { name: 'DIET', pct: Math.round((pastHistory.filter((e) => e.dietCompleted).length / n) * 100) },
      { name: 'WATER', pct: Math.round((pastHistory.filter((e) => e.waterCompleted).length / n) * 100) },
      { name: 'READING', pct: Math.round((pastHistory.filter((e) => e.readingCompleted).length / n) * 100) },
      { name: 'PHOTO', pct: Math.round((pastHistory.filter((e) => e.photoCompleted).length / n) * 100) },
    ].sort((a, b) => b.pct - a.pct);
  }, [pastHistory]);

  const totalWaterOz = sorted.reduce((s, e) => s + (e.waterOzLogged || 0), 0);
  const totalPages = sorted.reduce((s, e) => s + (e.pagesRead || 0), 0);
  const totalWorkoutMins = sorted.reduce((s, e) => s + (e.workoutOneCompleted ? (e.workoutOneDuration || 0) : 0) + (e.workoutTwoCompleted ? (e.workoutTwoDuration || 0) : 0), 0);
  const w1CompletedDays = sorted.filter((e) => e.workoutOneCompleted);
  const avgWorkoutMins = w1CompletedDays.length > 0
    ? Math.round(w1CompletedDays.reduce((s, e) => s + (e.workoutOneDuration || 0), 0) / w1CompletedDays.length)
    : 0;

  const summaryStats = [
    { icon: 'water-outline' as const, label: 'TOTAL WATER', value: `${(totalWaterOz / 128).toFixed(1)}gal` },
    { icon: 'book-outline' as const, label: 'TOTAL PAGES', value: String(totalPages) },
    { icon: 'timer-outline' as const, label: 'WORKOUT MINS', value: String(totalWorkoutMins) },
    { icon: 'barbell-outline' as const, label: 'AVG WORKOUT', value: `${avgWorkoutMins}min` },
  ];

  if (sorted.length === 0) return null;

  return (
    <View style={styles.insights}>
      {/* Challenge Progress */}
      <ChartCard title="CHALLENGE PROGRESS">
        <View style={styles.progressHeader}>
          <Text style={[styles.progressDay, { color: theme.accent }]}>DAY {challengeDay} / 75</Text>
          <Text style={[styles.progressComplete, { color: theme.textMuted }]}>{completedDays} COMPLETE</Text>
        </View>
        <View style={[styles.progressTrack, { borderColor: theme.border, backgroundColor: theme.bg }]}>
          <View style={[styles.progressFill, { width: `${challengePct}%` as any, backgroundColor: theme.accent, shadowColor: theme.accent }]} />
        </View>
        <View style={styles.progressFooter}>
          <Text style={[styles.progressLabel, { color: theme.textMuted }]}>DAY 1</Text>
          <Text style={[styles.progressLabel, { color: theme.accent }]}>{Math.round(challengePct)}%</Text>
          <Text style={[styles.progressLabel, { color: theme.textMuted }]}>DAY 75</Text>
        </View>
      </ChartCard>

      {/* Lifetime stats */}
      <View>
        <Text style={[styles.sectionHeader, { color: theme.textMuted }]}>LIFETIME STATS</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.statCards}>
            {summaryStats.map(({ icon, label, value }) => (
              <View key={label} style={[styles.statCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Ionicons name={icon} size={18} color={theme.textMuted} />
                <Text style={[styles.statValue, { color: theme.accent }]}>{value}</Text>
                <Text style={[styles.statLabel, { color: theme.textMuted }]}>{label}</Text>
              </View>
            ))}
            {weightChange != null && (
              <View style={[styles.statCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Ionicons name="scale-outline" size={18} color={theme.textMuted} />
                <Text style={[styles.statValue, { color: weightChange <= 0 ? theme.green : theme.red }]}>
                  {weightChange >= 0 ? '+' : ''}{weightChange.toFixed(1)}{weightUnit}
                </Text>
                <Text style={[styles.statLabel, { color: theme.textMuted }]}>WEIGHT CHANGE</Text>
              </View>
            )}
          </View>
        </ScrollView>
      </View>

      {/* Water chart */}
      {waterData.length >= 2 && (
        <ChartCard title="WATER INTAKE (30 DAYS)">
          <BarChart data={waterData} color={theme.accent} goalY={128} goalColor={theme.red} />
          <View style={styles.legend}>
            <View style={[styles.legendDot, { backgroundColor: theme.accent }]} />
            <Text style={[styles.legendText, { color: theme.textMuted }]}>Intake</Text>
            <View style={[styles.legendDash, { borderColor: theme.red }]} />
            <Text style={[styles.legendText, { color: theme.textMuted }]}>Goal (128oz)</Text>
          </View>
        </ChartCard>
      )}

      {/* Workout chart */}
      {workoutData.length >= 2 && (
        <ChartCard title="WORKOUT MINUTES (14 DAYS)">
          <StackedBarChart data={workoutData} />
          <View style={styles.legend}>
            <View style={[styles.legendDot, { backgroundColor: '#7a8898' }]} />
            <Text style={[styles.legendText, { color: theme.textMuted }]}>W1 (Indoor)</Text>
            <View style={[styles.legendDot, { backgroundColor: theme.green }]} />
            <Text style={[styles.legendText, { color: theme.textMuted }]}>W2 (Outdoor)</Text>
          </View>
        </ChartCard>
      )}

      {/* Reading chart */}
      {readingData.length >= 2 && (
        <ChartCard title="PAGES READ (30 DAYS)">
          <BarChart data={readingData} color="#7a5230" goalY={10} goalColor={theme.white} goalBorderColor={theme.bg} />
          <View style={styles.legend}>
            <View style={[styles.legendDot, { backgroundColor: '#7a5230' }]} />
            <Text style={[styles.legendText, { color: theme.textMuted }]}>Pages</Text>
            <View style={[styles.legendDash, { borderColor: theme.text }]} />
            <Text style={[styles.legendText, { color: theme.textMuted }]}>Goal (10pg)</Text>
          </View>
        </ChartCard>
      )}

      {/* Weight trend */}
      {weightData.length >= 2 && (
        <ChartCard title={`WEIGHT TREND (${weightUnit.toUpperCase()})`}>
          {weightChange != null && (
            <View style={styles.weightChangeRow}>
              <Text style={[styles.weightChangeVal, { color: weightChange <= 0 ? theme.green : theme.red }]}>
                {weightChange >= 0 ? '+' : ''}{weightChange.toFixed(1)} {weightUnit}
              </Text>
              <Text style={[styles.progressLabel, { color: theme.textMuted }]}>SINCE START</Text>
            </View>
          )}
          <LineChartSvg
            datasets={[{ data: weightData, color: theme.green }]}
            goalY={startingWeight}
            goalColor={theme.textMuted}
          />
        </ChartCard>
      )}

      {/* Mood & energy */}
      {moodData.length >= 2 && (
        <ChartCard title="MOOD & ENERGY (30 DAYS)">
          <LineChartSvg
            datasets={[
              { data: moodData, color: theme.accent },
              { data: energyData.filter((d) => d.y > 0), color: theme.green, dashed: true },
            ]}
          />
          <View style={styles.legend}>
            <View style={[styles.legendDot, { backgroundColor: theme.accent }]} />
            <Text style={[styles.legendText, { color: theme.textMuted }]}>Mood</Text>
            <View style={[styles.legendDot, { backgroundColor: theme.green }]} />
            <Text style={[styles.legendText, { color: theme.textMuted }]}>Energy</Text>
          </View>
        </ChartCard>
      )}

      {/* Task completion breakdown */}
      {taskBreakdown.length > 0 && (
        <ChartCard title="TASK COMPLETION RATE">
          <View style={styles.breakdown}>
            {taskBreakdown.map(({ name, pct }) => {
              const barColor = pct >= 90 ? '#3a8f52' : pct >= 60 ? theme.yellow : theme.red;
              return (
                <View key={name} style={styles.breakdownRow}>
                  <View style={styles.breakdownHeader}>
                    <Text style={[styles.breakdownName, { color: theme.text }]}>{name}</Text>
                    <Text style={[styles.breakdownPct, { color: barColor }]}>{pct}%</Text>
                  </View>
                  <View style={[styles.breakdownTrack, { backgroundColor: theme.bg, borderColor: theme.border }]}>
                    <View style={[styles.breakdownFill, { width: `${pct}%` as any, backgroundColor: barColor }]} />
                  </View>
                </View>
              );
            })}
          </View>
        </ChartCard>
      )}
    </View>
  );
}

// ── Main history page ──────────────────────────────────────────────────────────

function HistoryInner({ currentUser }: { currentUser: UserProfile }) {
  const { theme, isRocketMode } = useTheme();
  const { users: allUsers } = useAllUsers();
  const friendUids = new Set(currentUser.friends ?? []);
  const friendOrder = new Map((currentUser.friends ?? []).map((uid, i) => [uid, i]));
  const users = [
    ...allUsers.filter((u) => u.uid === currentUser.uid),
    ...allUsers
      .filter((u) => u.uid !== currentUser.uid && friendUids.has(u.uid))
      .sort((a, b) => (friendOrder.get(a.uid) ?? 999) - (friendOrder.get(b.uid) ?? 999)),
  ];
  const [viewUid, setViewUid] = useState(currentUser.uid);
  const [history, setHistory] = useState<DayEntry[]>([]);
  const [month, setMonth] = useState(new Date());
  const insets = useSafeAreaInsets();

  useEffect(() => {
    setHistory([]);
    getDayHistory(viewUid, 120).then(setHistory).catch(() => {});
  }, [viewUid]);

  const entryMap = new Map(history.map((e) => [e.date, e]));
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const startPad = getDay(monthStart);

  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const completed = history.filter((e) => e.allCoreCompleted).length;
  const total = history.filter((e) => {
    if (e.date === todayStr) return e.allCoreCompleted;
    return !isFuture(parseISO(e.date));
  }).length;

  const viewProfile = users.find((u) => u.uid === viewUid);
  const { current: currentStreak, longest } = viewProfile
    ? { current: viewProfile.currentStreak ?? 0, longest: viewProfile.longestStreak ?? 0 }
    : computeStreakFromHistory(history);
  const startDate = viewProfile?.challengeStartDate ?? null;
  const finishDateStr = startDate && viewProfile?.challengeMode !== 'general'
    ? format(addDays(parseISO(startDate), 79), 'yyyy-MM-dd')
    : null;

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: theme.bg }]}>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: 100 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.pageTitle, { color: theme.accent }]}>HISTORY</Text>

        {/* User switcher */}
        {users.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.userSwitcher}>
            {users.map((u) => (
              <TouchableOpacity
                key={u.uid}
                onPress={() => setViewUid(u.uid)}
                style={[
                  styles.userBtn,
                  { borderColor: theme.border, backgroundColor: theme.surface },
                  viewUid === u.uid && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
              >
                <Text style={[
                  styles.userBtnText,
                  { color: theme.text },
                  viewUid === u.uid && { color: theme.white },
                ]}>
                  {u.displayName.toUpperCase()}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {viewProfile && viewUid !== currentUser.uid && (
          <Text style={[styles.viewingLabel, { color: theme.textMuted }]}>VIEWING {viewProfile.displayName.toUpperCase()}'S HISTORY</Text>
        )}

        {/* Calendar */}
        <View nativeID="tutorial-calendar" style={[styles.calendarCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.calendarNav}>
            <TouchableOpacity onPress={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1))} style={styles.navBtn}>
              <Ionicons name="chevron-back" size={16} color={theme.text} />
            </TouchableOpacity>
            <Text style={[styles.monthLabel, { color: theme.text }]}>{format(month, 'MMM yyyy').toUpperCase()}</Text>
            <TouchableOpacity onPress={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1))} style={styles.navBtn}>
              <Ionicons name="chevron-forward" size={16} color={theme.text} />
            </TouchableOpacity>
          </View>

          <View style={styles.dayLabels}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <Text key={i} style={[styles.dayLabel, { color: theme.textMuted }]}>{d}</Text>
            ))}
          </View>

          <View style={styles.calendarGrid}>
            {(() => {
              const allCells: React.ReactNode[] = [];
              for (let i = 0; i < startPad; i++) {
                allCells.push(<View key={`pad-${i}`} style={[styles.calendarCell, { borderColor: theme.border, backgroundColor: theme.surface }]} />);
              }
              days.forEach((day) => {
                const dateStr = format(day, 'yyyy-MM-dd');
                const entry = entryMap.get(dateStr);
                allCells.push(
                  <View
                    key={dateStr}
                    style={[
                      styles.calendarCell,
                      { backgroundColor: tileColor(entry, day, startDate, theme), borderColor: tileBorder(entry, day, startDate, theme) },
                    ]}
                  >
                    <Text style={[styles.calendarDayNum, { color: theme.text }]}>{day.getDate()}</Text>
                    {dateStr === finishDateStr && (
                      <Ionicons name="star" size={12} color={theme.accent} style={styles.calendarFinishStar} />
                    )}
                  </View>
                );
              });
              const remainder = allCells.length % 7;
              if (remainder !== 0) {
                for (let i = 0; i < 7 - remainder; i++) {
                  allCells.push(<View key={`trail-${i}`} style={[styles.calendarCell, { borderColor: theme.border, backgroundColor: theme.surface }]} />);
                }
              }
              const rows: React.ReactNode[] = [];
              for (let r = 0; r < allCells.length; r += 7) {
                rows.push(
                  <View key={r} style={styles.calendarRow}>
                    {allCells.slice(r, r + 7)}
                  </View>
                );
              }
              return rows;
            })()}
          </View>

          <View style={styles.calendarLegend}>
            {[
              { bg: theme.greenLight, border: theme.green, label: 'Done' },
              { bg: theme.yellowLight, border: theme.yellow, label: 'Partial' },
              { bg: theme.redLight, border: theme.red, label: 'Missed' },
            ].map(({ bg, border, label }) => (
              <View key={label} style={styles.legendItem}>
                <View style={[styles.legendTile, { backgroundColor: bg, borderColor: border }]} />
                <Text style={[styles.legendText, { color: theme.textMuted }]}>{label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Stats */}
        <View nativeID="tutorial-stats" style={styles.statsGrid}>
          {[
            { label: 'CURRENT STREAK', value: `${currentStreak} DAYS` },
            { label: 'LONGEST STREAK', value: `${longest} DAYS` },
            { label: 'DAYS COMPLETE', value: String(completed) },
            { label: 'COMPLETION %', value: total > 0 ? `${Math.round((completed / total) * 100)}%` : '—' },
          ].map(({ label, value }) => (
            <View key={label} style={[styles.statBox, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.statBoxLabel, { color: theme.textMuted }]}>{label}</Text>
              <Text style={[styles.statBoxValue, { color: theme.accent }]}>{value}</Text>
            </View>
          ))}
        </View>

        <InsightsDashboard history={history} viewProfile={viewProfile} />
      </ScrollView>
    </View>
  );
}

export default function HistoryPage() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(() => getSessionCached<UserProfile>('crewday-profile'));
  useHideNavWhileLoading(!profile);

  useEffect(() => {
    if (user) getUserProfile(user.uid).then(setProfile);
  }, [user]);

  if (!profile) return <LoadingScreen />;
  return <HistoryInner currentUser={profile} />;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 16 },
  pageTitle: { fontFamily: fonts.pixel, fontSize: 14, marginBottom: 24 },
  userSwitcher: { flexDirection: 'row', gap: 8, marginBottom: 24, paddingRight: 16 },
  userBtn: { paddingHorizontal: 12, paddingVertical: 6, borderWidth: 2 },
  userBtnText: { fontFamily: fonts.pixel, fontSize: 8 },
  viewingLabel: { fontFamily: fonts.pixel, fontSize: 7, marginBottom: 16 },
  calendarCard: {
    padding: 16, marginBottom: 24,
    borderWidth: 2,
    shadowColor: '#1a1008', shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.3, shadowRadius: 0, elevation: 2,
  },
  calendarNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  navBtn: { padding: 4 },
  monthLabel: { fontFamily: fonts.pixel, fontSize: 9 },
  dayLabels: { flexDirection: 'row', marginBottom: 4 },
  dayLabel: { flex: 1, textAlign: 'center', fontFamily: fonts.pixel, fontSize: 7 },
  calendarGrid: { flexDirection: 'column' },
  calendarRow: { flexDirection: 'row' },
  calendarCell: {
    flex: 1, aspectRatio: 1,
    borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
    position: 'relative',
  },
  calendarDayNum: { fontFamily: fonts.interSemiBold, fontSize: 12, textAlign: 'center' },
  calendarFinishStar: { position: 'absolute', top: 1, right: 1 },
  calendarLegend: { flexDirection: 'row', gap: 12, marginTop: 12, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendTile: { width: 12, height: 12, borderWidth: 2 },
  legendText: { fontFamily: fonts.inter, fontSize: 11 },
  legend: { flexDirection: 'row', gap: 12, marginTop: 8, alignItems: 'center' },
  legendDot: { width: 10, height: 10 },
  legendDash: { width: 16, height: 0, borderTopWidth: 2, borderStyle: 'dashed' },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 8 },
  statBox: {
    flex: 1, minWidth: '45%', padding: 12,
    borderWidth: 2,
    shadowColor: '#1a1008', shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.3, shadowRadius: 0, elevation: 2,
  },
  statBoxLabel: { fontFamily: fonts.pixel, fontSize: 6, marginBottom: 6 },
  statBoxValue: { fontFamily: fonts.pixel, fontSize: 12 },
  insights: { gap: 16, marginTop: 8 },
  chartCard: {
    padding: 16,
    borderWidth: 2,
    shadowColor: '#1a1008', shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.3, shadowRadius: 0, elevation: 2,
  },
  chartTitle: { fontFamily: fonts.pixel, fontSize: 7, marginBottom: 12 },
  progressHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  progressDay: { fontFamily: fonts.vt323, fontSize: 22 },
  progressComplete: { fontFamily: fonts.vt323, fontSize: 18 },
  progressTrack: {
    height: 24, borderWidth: 2,
    marginBottom: 4,
  },
  progressFill: {
    height: '100%',
    shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 8,
  },
  progressFooter: { flexDirection: 'row', justifyContent: 'space-between' },
  progressLabel: { fontFamily: fonts.pixel, fontSize: 6 },
  sectionHeader: { fontFamily: fonts.pixel, fontSize: 7, marginBottom: 8 },
  statCards: { flexDirection: 'row', gap: 12 },
  statCard: {
    minWidth: 90, padding: 12,
    borderWidth: 2,
    shadowColor: '#1a1008', shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.3, shadowRadius: 0,
    alignItems: 'center', gap: 4,
  },
  statValue: { fontFamily: fonts.pixel, fontSize: 12, textAlign: 'center' },
  statLabel: { fontFamily: fonts.pixel, fontSize: 5, textAlign: 'center', lineHeight: 8 },
  weightChangeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  weightChangeVal: { fontFamily: fonts.vt323, fontSize: 20 },
  breakdown: { gap: 8 },
  breakdownRow: { gap: 4 },
  breakdownHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  breakdownName: { fontFamily: fonts.pixel, fontSize: 6 },
  breakdownPct: { fontFamily: fonts.pixel, fontSize: 6 },
  breakdownTrack: { height: 12, borderWidth: 1 },
  breakdownFill: { height: '100%' },
});
