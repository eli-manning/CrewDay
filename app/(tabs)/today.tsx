import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet, Modal, useWindowDimensions } from 'react-native';
import { format, differenceInDays, parseISO, subDays } from 'date-fns';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';
import { getFirebaseDb } from '../../lib/firebase';
import { useAuth } from '../../hooks/useAuth';
import { useRouter, useFocusEffect } from 'expo-router';
import { useAllUsers } from '../../hooks/useAllUsers';
import { useDayData } from '../../hooks/useDayData';
import { useCustomTasks } from '../../hooks/useCustomTasks';
import { useUserCrews } from '../../hooks/useUserCrews';
import { useMinDuration } from '../../hooks/useMinDuration';
import { getUserProfile, getAllUsers, getPendingRequests, getDayEntry, getDayHistory, updateUserProfile, updateDayEntryWithPoints, updateStreakOnProfile, subscribeToProfile, defaultDayEntry } from '../../lib/firestore';
import { getCached, setCached, getSessionCached, setSessionCached, clearAll } from '../../lib/cache';
import { getCrewIconIon } from '../../lib/crews';
import { UserProfile, DayEntry } from '../../lib/types';
import { LoadingScreen } from '../../components/LoadingScreen';
import { useHideNavWhileLoading } from '../../context/NavVisibilityContext';
import { UserTabBar } from '../../components/UserTabBar';
import { DailyProgress } from '../../components/DailyProgress';
import { ChallengeChecklist } from '../../components/ChallengeChecklist';
import { CustomTaskList } from '../../components/CustomTaskList';
import { DaySummaryModal } from '../../components/DaySummaryModal';
import { SideMenu } from '../../components/SideMenu';
import { MilestoneBanner } from '../../components/MilestoneBanner';
import { RestartModal } from '../../components/RestartModal';
import { MissedDayModal } from '../../components/MissedDayModal';
import { computeDayPoints, computeAllCoreCompleted } from '../../lib/points';
import { colors, fonts } from '../../lib/theme';
import { useTheme } from '../../context/ThemeContext';
import { useTutorial } from '../../context/TutorialContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function DaySkeleton({ profile }: { profile: UserProfile }) {
  const { theme } = useTheme();
  const today = format(new Date(), 'MMMM d, yyyy').toUpperCase();
  return (
    <View style={styles.skeletonContainer}>
      <View style={styles.skeletonHeader}>
        <Text style={[styles.skeletonDayNum, { color: theme.accent }]}>DAY —</Text>
        <Text style={[styles.skeletonDate, { color: theme.textMuted }]}>{today}</Text>
      </View>
      <View style={[styles.skeletonBar, { borderColor: theme.border, backgroundColor: theme.surface }]} />
      <Text style={[styles.skeletonLabel, { color: theme.textMuted }]}>CORE TASKS</Text>
      {[...Array(6)].map((_, i) => (
        <View key={i} style={[styles.skeletonTask, { borderColor: theme.border, backgroundColor: theme.surface, opacity: 1 - i * 0.1 }]} />
      ))}
    </View>
  );
}

function CrewTaskCard({
  task, completed, readOnly, progress,
  onToggle, onSetProgress, onResetProgress,
}: {
  task: import('../../lib/types').CrewTask;
  completed: boolean;
  readOnly: boolean;
  progress: number;
  onToggle: () => void;
  onSetProgress: (n: number) => void;
  onResetProgress: () => void;
}) {
  const { theme } = useTheme();
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState(false);
  const isGoal = task.amount != null;
  const goalAmount = task.amount ?? 0;
  const unitLabel = task.unit ? ` ${task.unit}` : '';
  const fillPct = isGoal && goalAmount > 0 ? Math.min(100, (progress / goalAmount) * 100) : 0;

  function handleSet() {
    const n = parseInt(input, 10);
    if (isNaN(n) || n < 0) { setInputError(true); return; }
    setInputError(false);
    setInput('');
    onSetProgress(n);
  }

  const inner = (
    <View style={[
      styles.crewTaskCard,
      completed
        ? { borderColor: theme.green, backgroundColor: theme.greenLight, shadowColor: theme.green, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.3, shadowRadius: 6 }
        : { borderColor: theme.border, backgroundColor: theme.surface },
    ]}>
      <View style={[
        styles.crewCheckbox,
        completed
          ? { borderColor: theme.green, backgroundColor: theme.green, shadowColor: theme.green, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 8 }
          : { borderColor: theme.textMuted, backgroundColor: 'transparent' },
      ]}>
        {completed && (
          <Svg width={12} height={10} viewBox="0 0 12 10" fill="none">
            <Path d="M1 5l3 3 7-7" stroke={theme.bg} strokeWidth={2.5} strokeLinecap="square" />
          </Svg>
        )}
      </View>
      <View style={styles.crewTaskBody}>
        <Text style={[styles.crewTaskLabel, { color: completed ? theme.green : theme.text }, completed && styles.crewTaskLabelDone]} numberOfLines={2}>
          {task.label}
        </Text>
        {isGoal && (
          <View style={styles.crewGoalArea}>
            <View style={styles.crewBarRow}>
              <View style={[styles.crewBarTrack, { borderColor: theme.border, backgroundColor: theme.bg }]}>
                <View style={[styles.crewBarFill, { width: `${fillPct}%` as any, backgroundColor: completed ? theme.green : theme.accent }]} />
              </View>
              <Text style={[styles.crewProgressLabel, { color: completed ? theme.green : theme.textMuted }]}>
                {progress}/{goalAmount}{unitLabel}
              </Text>
            </View>
            {!readOnly && (
              <View style={styles.crewSetRow}>
                <TextInput
                  value={input}
                  onChangeText={(t) => { setInput(t.replace(/[^0-9]/g, '')); setInputError(false); }}
                  keyboardType="number-pad"
                  placeholder="0"
                  placeholderTextColor={theme.textMuted}
                  style={[styles.crewGoalInput, { borderColor: inputError ? theme.red : theme.border, backgroundColor: theme.surface2, color: theme.text }]}
                  maxLength={6}
                  onSubmitEditing={handleSet}
                />
                <TouchableOpacity onPress={handleSet} style={[styles.crewSetBtn, { borderColor: theme.accent, backgroundColor: theme.accentLight }]}>
                  <Text style={[styles.crewSetBtnText, { color: theme.accent }]}>SET</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={onResetProgress} style={[styles.crewResetBtn, { borderColor: theme.border, backgroundColor: theme.surface2 }]}>
                  <Text style={[styles.crewResetBtnText, { color: theme.textMuted }]}>RESET</Text>
                </TouchableOpacity>
              </View>
            )}
            {inputError && <Text style={[styles.crewGoalErrorText, { color: theme.red }]}>ENTER A VALID NUMBER</Text>}
          </View>
        )}
        {!isGoal && task.unit != null && (
          <View style={[styles.crewAmountBadge, { borderColor: theme.border, backgroundColor: theme.surface2 }]}>
            <Text style={[styles.crewAmountText, { color: theme.text }]}>{task.amount}{task.unit ? ` ${task.unit.toUpperCase()}` : ''}</Text>
          </View>
        )}
      </View>
    </View>
  );

  if (readOnly || isGoal) return inner;
  return <TouchableOpacity activeOpacity={0.85} onPress={onToggle}>{inner}</TouchableOpacity>;
}

function TodayInner({ currentUser, onProfileUpdate }: { currentUser: UserProfile; onProfileUpdate: (p: UserProfile) => void }) {
  const { theme, isRocketMode } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  // Scale pixel-font day header so "DAY XX | XX,XXX PTS" always fits on one line
  const dayNumFontSize  = Math.min(26, Math.floor(screenWidth * 0.057));
  const generalFontSize = Math.min(36, Math.floor(screenWidth * 0.077));
  const { crews } = useUserCrews(currentUser.uid);
  const { users: allUsers } = useAllUsers();
  const users = useMemo(() => {
    const friendSet = new Set(currentUser.friends ?? []);
    const friendOrder = new Map((currentUser.friends ?? []).map((uid, i) => [uid, i]));
    const me = allUsers.filter((u) => u.uid === currentUser.uid);
    const friendsSorted = allUsers
      .filter((u) => u.uid !== currentUser.uid && friendSet.has(u.uid))
      .sort((a, b) => (friendOrder.get(a.uid) ?? 999) - (friendOrder.get(b.uid) ?? 999));
    return [...me, ...friendsSorted];
  }, [allUsers, currentUser.uid, currentUser.friends]);

  const [activeUid, setActiveUid] = useState(currentUser.uid);
  const [activeProfile, setActiveProfile] = useState<UserProfile>(currentUser);

  // Reset to own day whenever the signed-in user changes (e.g. after sign-out + sign-in)
  useEffect(() => {
    setActiveUid(currentUser.uid);
    setActiveProfile(currentUser);
  }, [currentUser.uid]);

  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingRequestCount, setPendingRequestCount] = useState(0);
  const [coreOpen, setCoreOpen] = useState(true);
  const [crewOpen, setCrewOpen] = useState(true);
  const [nudgedTasks, setNudgedTasks] = useState<Set<string>>(new Set());
  const [pendingNudge, setPendingNudge] = useState<{ taskKey: string; message: string } | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [dayCompleted, setDayCompleted] = useState(false);
  const summaryShownRef = useRef(false);
  const hasSeenIncompleteRef = useRef(false);
  const prevCrewCompletedRef = useRef<Map<string, boolean>>(new Map());
  const [dismissedMilestone, setDismissedMilestone] = useState<number | null>(null);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [restartForced, setRestartForced] = useState(false);
  const [showMissedDay, setShowMissedDay] = useState(false);
  const [yesterdayEntry, setYesterdayEntry] = useState<DayEntry | null>(null);
  const missedDayChecked = useRef(false);
  const insets = useSafeAreaInsets();
  const { startTutorial, registerActionHandler, isActive: tutorialIsActive } = useTutorial();
  const tutorialFiredRef = useRef(false);

  useEffect(() => {
    getPendingRequests(currentUser.uid)
      .then((reqs) => setPendingRequestCount(reqs.length))
      .catch(() => {});
  }, [currentUser.uid]);

  // Fire tutorial once for new users (after a short delay so the screen settles)
  useEffect(() => {
    if (tutorialIsActive) return; // already running — don't restart on remount
    if (tutorialFiredRef.current) return;
    if (currentUser.tutorialSeen) return;
    tutorialFiredRef.current = true;
    const t = setTimeout(() => startTutorial(currentUser.uid), 900);
    return () => clearTimeout(t);
  }, [currentUser.uid, currentUser.tutorialSeen, startTutorial, tutorialIsActive]);

  // Register tutorial action handlers
  useEffect(() => {
    return registerActionHandler('open-menu', () => setMenuOpen(true));
  }, [registerActionHandler]);

  useEffect(() => {
    return registerActionHandler('collapse-core-tasks', () => setCoreOpen(false));
  }, [registerActionHandler]);

  const readOnly = activeUid !== currentUser.uid;
  const { dayEntry, loading: dayLoading, optimisticPatch } = useDayData(activeUid, activeProfile.challengeStartDate, activeUid === currentUser.uid);
  // Tracks the running optimistic state between taps and snapshot arrival.
  // Cleared to null whenever a Firestore snapshot updates dayEntry.
  const optimisticEntryRef = useRef<DayEntry | null>(null);
  useEffect(() => { optimisticEntryRef.current = null; }, [dayEntry]);
  const { tasks } = useCustomTasks(activeUid);

  // Reset prev-state tracking when switching between users so we don't false-trigger on return
  useEffect(() => {
    hasSeenIncompleteRef.current = false;
    prevCrewCompletedRef.current = new Map();
  }, [activeUid]);

  // Detect own-day allCoreCompleted false→true transition and show summary modal
  useEffect(() => {
    if (!dayEntry || activeUid !== currentUser.uid || summaryShownRef.current) return;
    if (!dayEntry.allCoreCompleted) {
      hasSeenIncompleteRef.current = true;
    } else if (hasSeenIncompleteRef.current) {
      summaryShownRef.current = true;
      setDayCompleted(true);
      setShowSummary(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayEntry?.allCoreCompleted, activeUid]);

  // Trigger crew evaluation when this user completes all of a crew's specific requirements
  useEffect(() => {
    if (!dayEntry || activeUid !== currentUser.uid || !crews.length) return;
    const CORE_FIELD: Record<string, keyof DayEntry> = {
      workout1: 'workoutOneCompleted',
      workout2: 'workoutTwoCompleted',
      diet: 'dietCompleted',
      water: 'waterCompleted',
      reading: 'readingCompleted',
      photo: 'photoCompleted',
    };
    const fn = httpsCallable(getFunctions(undefined, 'us-west2'), 'triggerCrewEvaluation');
    for (const crew of crews) {
      const activeTasks = crew.activeTasks ?? {};
      const coreOk = Object.entries(activeTasks).every(
        ([key, required]) => !required || !!(dayEntry as Record<string, unknown>)[CORE_FIELD[key as keyof typeof CORE_FIELD]]
      );
      const crewTasksCompleted = dayEntry.crewTasksCompleted ?? [];
      const activeCrewTasks = crew.customCrewTasks.filter((t) => !(t as any).archived);
      const customOk = activeCrewTasks.length === 0 || activeCrewTasks.every((t) => crewTasksCompleted.includes(t.id));
      const nowComplete = coreOk && customOk;
      const wasComplete = prevCrewCompletedRef.current.get(crew.id) ?? false;
      prevCrewCompletedRef.current.set(crew.id, nowComplete);
      if (!wasComplete && nowComplete) {
        fn({ crewId: crew.id, date: todayStr }).catch(console.error);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayEntry, crews, activeUid]);

  const isTabSwitch = activeUid !== currentUser.uid && profileLoading;
  const showSkeleton = useMinDuration(isTabSwitch || (dayLoading && !dayEntry), 600);

  useEffect(() => {
    const today = format(new Date(), 'yyyy-MM-dd');
    for (const friend of users) {
      if (friend.uid === currentUser.uid) continue;
      const key = `day-${friend.uid}-${today}`;
      if (!getCached<DayEntry>(key)) {
        // Read-only fetch — we don't have write permission on friends' entries.
        // If they haven't opened the app yet today, getDayEntry returns null and
        // useDayData will fall back to a default entry automatically.
        getDayEntry(friend.uid, today).then((entry) => {
          if (entry) setCached(key, entry);
        }).catch(() => {});
      }
    }
  }, [users, currentUser.uid]);

  useEffect(() => {
    if (activeUid === currentUser.uid) {
      setActiveProfile(currentUser);
      setProfileError(false);
      return;
    }
    const found = users.find((u) => u.uid === activeUid);
    if (found) {
      setActiveProfile(found);
      setProfileError(false);
      setProfileLoading(false);
      return;
    }
    setProfileLoading(true);
    setProfileError(false);
    getUserProfile(activeUid)
      .then((p) => {
        if (p) setActiveProfile(p);
        else setProfileError(true);
      })
      .catch(() => setProfileError(true))
      .finally(() => setProfileLoading(false));
  }, [activeUid, currentUser, users]);

  useEffect(() => {
    if (readOnly || missedDayChecked.current) return;
    if (!dayEntry || currentUser.challengeMode !== '75hard' || !currentUser.challengeStartDate) return;
    const yesterday = format(subDays(new Date(), 1), 'yyyy-MM-dd');
    if (currentUser.missedDayPromptShownDate === yesterday) return;
    missedDayChecked.current = true;
    if (yesterday < currentUser.challengeStartDate) return;
    getDayEntry(activeUid, yesterday)
      .then((entry) => {
        if (!entry || !entry.allCoreCompleted) {
          const fallback = entry ?? (defaultDayEntry(activeUid, yesterday, currentUser.challengeStartDate) as DayEntry);
          setYesterdayEntry(fallback);
          setShowMissedDay(true);
          updateUserProfile(activeUid, { missedDayPromptShownDate: yesterday }).catch(() => {});
          onProfileUpdate({ ...currentUser, missedDayPromptShownDate: yesterday });
        }
      })
      .catch(() => {});
  }, [dayEntry, readOnly, currentUser.challengeMode, currentUser.challengeStartDate, currentUser.missedDayPromptShownDate]);

  const todayStr = format(new Date(), 'yyyy-MM-dd');

  const wrappedUpdate = useCallback(async (patch: Partial<DayEntry>) => {
    const base = optimisticEntryRef.current ?? dayEntry;
    if (!base) return;
    const merged = { ...base, ...patch };
    const newPts = computeDayPoints(merged, tasks, currentUser);
    const oldPts = base.dailyPoints ?? 0;
    const delta = newPts - oldPts;
    // Update optimistic ref immediately so rapid taps compute the correct delta.
    optimisticEntryRef.current = { ...merged, dailyPoints: newPts };
    optimisticPatch({ ...patch, dailyPoints: newPts });
    try {
      await updateDayEntryWithPoints(activeUid, todayStr, { ...patch, dailyPoints: newPts }, delta);
      if (delta !== 0) {
        onProfileUpdate({ ...currentUser, totalPoints: Math.max(0, (currentUser.totalPoints ?? 0) + delta) });
      }
    } catch {
      optimisticEntryRef.current = null;
    }
  }, [dayEntry, tasks, activeUid, todayStr, currentUser, onProfileUpdate, optimisticPatch]);

  async function handleRestartConfirm({ keepPoints, keepLongestStreak }: { keepPoints: boolean; keepLongestStreak: boolean }) {
    const newStartDate = format(new Date(), 'yyyy-MM-dd');
    try {
      await updateUserProfile(activeUid, {
        challengeStartDate: newStartDate,
        currentStreak: 0,
        ...(keepLongestStreak ? {} : { longestStreak: 0 }),
        ...(keepPoints ? {} : { totalPoints: 0 }),
      });
      clearAll();
      onProfileUpdate({
        ...currentUser,
        challengeStartDate: newStartDate,
        currentStreak: 0,
        ...(keepLongestStreak ? {} : { longestStreak: 0 }),
        ...(keepPoints ? {} : { totalPoints: 0 }),
      });
      setShowRestartModal(false);
      setShowMissedDay(false);
      setRestartForced(false);
    } catch {
      // write failed; modals stay open so the user can retry
    }
  }

  const nudgeQuota = useMemo(() => {
    if (!currentUser.nudgeResetDate || currentUser.nudgeResetDate !== todayStr) {
      return { remaining: 5, purchased: 0 };
    }
    return {
      remaining: currentUser.nudgesRemaining ?? 5,
      purchased: currentUser.purchasedNudgesToday ?? 0,
    };
  }, [currentUser, todayStr]);

  async function writeNudgeDoc(taskKey: string, message: string): Promise<void> {
    await addDoc(collection(getFirebaseDb(), 'nudges'), {
      fromUid: currentUser.uid,
      toUid: activeProfile.uid,
      fromName: currentUser.displayName,
      message,
      taskKey,
      sentAt: serverTimestamp(),
    });
  }

  function scheduleNudgeClear(taskKey: string) {
    setTimeout(() => setNudgedTasks((prev) => {
      const next = new Set(prev);
      next.delete(taskKey);
      return next;
    }), 60_000);
  }

  async function doSendNudge(taskKey: string, message: string) {
    setNudgedTasks((prev) => new Set([...prev, taskKey]));
    try {
      await writeNudgeDoc(taskKey, message);
      onProfileUpdate({
        ...currentUser,
        nudgeResetDate: todayStr,
        nudgesRemaining: Math.max(0, nudgeQuota.remaining - 1),
        purchasedNudgesToday: nudgeQuota.purchased,
      });
    } catch {
      setNudgedTasks((prev) => { const next = new Set(prev); next.delete(taskKey); return next; });
      return;
    }
    scheduleNudgeClear(taskKey);
  }

  async function handleSpendPoints() {
    if (!pendingNudge) return;
    const { taskKey, message } = pendingNudge;
    setPendingNudge(null);
    setNudgedTasks((prev) => new Set([...prev, taskKey]));
    try {
      await writeNudgeDoc(taskKey, message);
      onProfileUpdate({
        ...currentUser,
        nudgeResetDate: todayStr,
        nudgesRemaining: 0,
        purchasedNudgesToday: nudgeQuota.purchased + 1,
        totalPoints: Math.max(0, (currentUser.totalPoints ?? 0) - 10),
      });
    } catch {
      setNudgedTasks((prev) => { const next = new Set(prev); next.delete(taskKey); return next; });
      return;
    }
    scheduleNudgeClear(taskKey);
  }

  async function sendNudge(taskKey: string, message: string) {
    if (nudgedTasks.has(taskKey)) return;
    if (nudgeQuota.remaining <= 0) {
      setPendingNudge({ taskKey, message });
      return;
    }
    await doSendNudge(taskKey, message);
  }
  const today = format(new Date(), 'MMMM d, yyyy').toUpperCase();
  const streak = activeProfile.currentStreak ?? 0;
  const dayNum = activeProfile.challengeStartDate
    ? differenceInDays(parseISO(todayStr), parseISO(activeProfile.challengeStartDate)) + 1
    : 0;

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {showSummary && dayEntry && (
        <DaySummaryModal
          visible={showSummary}
          onDismiss={() => setShowSummary(false)}
          dayEntry={dayEntry}
          userProfile={currentUser}
          date={todayStr}
        />
      )}
      <RestartModal
        visible={showRestartModal}
        onConfirm={handleRestartConfirm}
        onCancel={() => setShowRestartModal(false)}
        cancellable={!restartForced}
      />
      {yesterdayEntry && (
        <MissedDayModal
          visible={showMissedDay}
          yesterdayEntry={yesterdayEntry}
          onMissed={() => { setShowMissedDay(false); setRestartForced(true); setShowRestartModal(true); }}
          onSaved={async (patch) => {
            if (!yesterdayEntry) return;
            const merged = { ...yesterdayEntry, ...patch };
            const allCoreCompleted = computeAllCoreCompleted(merged, activeProfile);
            const finalEntry = { ...merged, allCoreCompleted };
            const newPts = computeDayPoints(finalEntry, tasks);
            const oldPts = yesterdayEntry.dailyPoints ?? 0;
            const delta = newPts - oldPts;
            const yesterday = format(subDays(new Date(), 1), 'yyyy-MM-dd');
            await updateDayEntryWithPoints(activeUid, yesterday, { ...patch, allCoreCompleted, dailyPoints: newPts }, delta);
            if (delta !== 0) {
              onProfileUpdate({ ...currentUser, totalPoints: Math.max(0, (currentUser.totalPoints ?? 0) + delta) });
            }
            await updateStreakOnProfile(activeUid, currentUser.challengeStartDate).catch(() => {});
            setShowMissedDay(false);
          }}
          onDismiss={() => setShowMissedDay(false)}
        />
      )}
      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        {users.length > 0 ? (
          <UserTabBar users={users} activeUid={activeUid} onSelectUser={setActiveUid} currentUserUid={currentUser.uid} />
        ) : <View />}
        <View style={styles.hamburgerWrapper} nativeID="tutorial-hamburger">
          <TouchableOpacity
            onPress={() => setMenuOpen(true)}
            style={styles.hamburger}
          >
            <View style={[styles.hamburgerLine, { backgroundColor: theme.text }]} />
            <View style={[styles.hamburgerLine, { backgroundColor: theme.text }]} />
            <View style={[styles.hamburgerLine, { backgroundColor: theme.text }]} />
          </TouchableOpacity>
          {pendingRequestCount > 0 && <View style={[styles.notifDot, { backgroundColor: theme.red, borderColor: theme.bg }]} />}
        </View>
      </View>

      <SideMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        profile={currentUser}
        onProfileUpdate={onProfileUpdate}
        onRequestsSeen={() => setPendingRequestCount(0)}
      />

      {pendingNudge && (
        <Modal transparent animationType="fade">
          <View style={styles.spendBackdrop}>
            <View style={[styles.spendCard, { backgroundColor: theme.surface, borderColor: theme.accent }]}>
              {nudgeQuota.purchased >= 5 || (currentUser.totalPoints ?? 0) < 10 ? (
                <>
                  <Text style={[styles.spendTitle, { color: theme.accent }]}>NOT ENOUGH POINTS</Text>
                  <Text style={[styles.spendBody, { color: theme.textMuted }]}>
                    {nudgeQuota.purchased >= 5
                      ? "You've sent 5 paid nudges today. Try again tomorrow."
                      : `You need 10 points to send a nudge. You have ${currentUser.totalPoints ?? 0}.`}
                  </Text>
                  <TouchableOpacity onPress={() => setPendingNudge(null)} style={[styles.spendCancelBtn, { borderColor: theme.border }]}>
                    <Text style={[styles.spendCancelText, { color: theme.textMuted }]}>OK</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <Text style={[styles.spendTitle, { color: theme.accent }]}>SPEND 10 POINTS?</Text>
                  <Text style={[styles.spendBody, { color: theme.textMuted }]}>
                    {"You've used all 5 free nudges today.\n"}
                    {`You have ${currentUser.totalPoints ?? 0} points.\n`}
                    {`Paid nudges today: ${nudgeQuota.purchased}/5`}
                  </Text>
                  <View style={styles.spendBtns}>
                    <TouchableOpacity onPress={() => setPendingNudge(null)} style={[styles.spendCancelBtn, { borderColor: theme.border }]}>
                      <Text style={[styles.spendCancelText, { color: theme.textMuted }]}>CANCEL</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={handleSpendPoints} style={[styles.spendConfirmBtn, { borderColor: theme.accent, backgroundColor: theme.accentLight }]}>
                      <Text style={[styles.spendConfirmText, { color: theme.accent }]}>SPEND 10 PTS</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>
          </View>
        </Modal>
      )}

      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: 100 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        {readOnly && !showSkeleton && (
          <View style={[styles.viewingBanner, { borderColor: theme.border, backgroundColor: theme.surface2 }]}>
            <Text style={[styles.viewingBannerText, { color: theme.textMuted }]}>
              VIEWING {activeProfile.displayName.toUpperCase()}'S DAY
            </Text>
            <Text style={[styles.nudgeQuotaText, { color: theme.textMuted }]}>
              {nudgeQuota.remaining > 0
                ? `${nudgeQuota.remaining} NUDGE${nudgeQuota.remaining !== 1 ? 'S' : ''} LEFT TODAY`
                : '0 FREE — 10 PTS EACH'}
            </Text>
          </View>
        )}

        {profileError && (
          <View style={[styles.errorBanner, { borderColor: theme.red, backgroundColor: theme.redLight }]}>
            <Text style={[styles.errorBannerText, { color: theme.red }]}>FAILED TO LOAD USER DATA</Text>
          </View>
        )}

        {showSkeleton ? (
          <DaySkeleton profile={activeProfile} />
        ) : (
          <View style={styles.content}>
            {!readOnly && dayCompleted && !showSummary && (
              <TouchableOpacity
                style={[styles.summaryBanner, { backgroundColor: theme.accent, borderColor: theme.accent, shadowColor: theme.accent }]}
                onPress={() => setShowSummary(true)}
                activeOpacity={0.85}
              >
                <Text style={styles.summaryBannerText}>DAY COMPLETE — VIEW SUMMARY</Text>
                <Ionicons name="chevron-forward" size={12} color={theme.white} />
              </TouchableOpacity>
            )}
            <View style={styles.dayHeader} nativeID="tutorial-day-header">
              {activeProfile.challengeMode === 'general' ? (
                <View style={[styles.dayNumRow, { flexWrap: 'nowrap' }]}>
                  <Text numberOfLines={1} style={[styles.generalDate, { fontSize: generalFontSize, color: theme.accent, textShadowColor: theme.accentGlow }]}>{format(new Date(), 'EEE,MMM d').toUpperCase()}</Text>
                  {(activeProfile.totalPoints ?? 0) > 0 && (
                    <>
                      <Text style={[styles.dayNumSep, { fontSize: generalFontSize * 0.56, color: theme.textMuted }]}>|</Text>
                      <Text numberOfLines={1} style={[styles.generalDate, { fontSize: generalFontSize, color: theme.accent, textShadowColor: theme.accentGlow }]}>{activeProfile.totalPoints ?? 0} PTS</Text>
                    </>
                  )}
                </View>
              ) : dayNum <= 0 ? (
                <>
                  <Text style={[styles.startsInLabel, { color: theme.textMuted }]}>STARTING SOON</Text>
                  <Text style={[styles.daysUntil, { color: theme.accent, textShadowColor: theme.accentGlow }]}>{Math.abs(dayNum) + 1} {Math.abs(dayNum) + 1 === 1 ? 'DAY' : 'DAYS'} AWAY</Text>
                </>
              ) : (
                <View style={[styles.dayNumRow, { flexWrap: 'nowrap' }]}>
                  <Text numberOfLines={1} style={[styles.dayNumSmall, { fontSize: dayNumFontSize, color: theme.accent, textShadowColor: theme.accentGlow }]}>DAY {dayNum}</Text>
                  {(activeProfile.totalPoints ?? 0) > 0 && (
                    <>
                      <Text style={[styles.dayNumSep, { fontSize: dayNumFontSize * 0.77, color: theme.textMuted }]}>|</Text>
                      <Text numberOfLines={1} style={[styles.dayNumSmall, { fontSize: dayNumFontSize, color: theme.accent, textShadowColor: theme.accentGlow }]}>{activeProfile.totalPoints ?? 0} PTS</Text>
                    </>
                  )}
                </View>
              )}
              {activeProfile.challengeMode !== 'general' && <Text style={[styles.dateText, { color: theme.textMuted }]}>{today}</Text>}
              {dayEntry && !!activeProfile.challengeStartDate && <DailyProgress entry={dayEntry} />}
            </View>

            {!readOnly && dayNum > 0 && [25, 50, 75].includes(dayNum) && dismissedMilestone !== dayNum && (
              <MilestoneBanner dayNum={dayNum} onDismiss={() => setDismissedMilestone(dayNum)} />
            )}

            <View nativeID="tutorial-core-tasks">
              <TouchableOpacity onPress={() => setCoreOpen((o) => !o)} style={styles.sectionToggle}>
                <Ionicons name={coreOpen ? 'chevron-down' : 'chevron-forward'} size={12} color={theme.text} />
                <Text style={[styles.sectionLabel, { color: theme.text }]}>CORE TASKS</Text>
              </TouchableOpacity>
              {coreOpen && dayEntry && (
                <ChallengeChecklist
                  entry={dayEntry}
                  readOnly={readOnly}
                  onUpdate={wrappedUpdate}
                  weightUnit={currentUser.weightUnit ?? 'lbs'}
                  onNudge={readOnly ? sendNudge : undefined}
                  nudgedTasks={readOnly ? nudgedTasks : undefined}
                  challengeMode={activeProfile.challengeMode}
                  hiddenCoreTasks={!readOnly ? currentUser.hiddenCoreTasks : undefined}
                />
              )}
            </View>

            {dayEntry && (
              <View nativeID="tutorial-custom-tasks">
                <CustomTaskList
                  tasks={tasks}
                  dayEntry={dayEntry}
                  uid={activeUid}
                  readOnly={readOnly}
                  hideActions={true}
                  onDayUpdate={wrappedUpdate}
                  onNudge={readOnly ? sendNudge : undefined}
                  nudgedTasks={readOnly ? nudgedTasks : undefined}
                />
              </View>
            )}

            {!readOnly && dayEntry && crews.some((c) => c.customCrewTasks.length > 0) && (
              <View style={styles.crewTasksSection}>
                <TouchableOpacity onPress={() => setCrewOpen((o) => !o)} style={[styles.sectionToggle, { marginBottom: 0 }]}>
                  <Ionicons name={crewOpen ? 'chevron-down' : 'chevron-forward'} size={12} color={theme.text} />
                  <Text style={[styles.sectionLabel, { color: theme.text }]}>CREW TASKS</Text>
                </TouchableOpacity>
                {crewOpen && <View style={styles.crewTaskGroups}>{crews.filter((c) => c.customCrewTasks.length > 0).map((crew) => (
                  <View key={crew.id} style={styles.crewTaskGroup}>
                    <View style={styles.crewTaskGroupHeader}>
                      <Ionicons name={getCrewIconIon(crew.icon) as any} size={12} color={theme.textMuted} />
                      <Text style={[styles.crewTaskGroupName, { color: theme.textMuted }]}>{crew.name.toUpperCase()}</Text>
                    </View>
                    <View style={styles.crewTaskList}>
                      {crew.customCrewTasks.map((task) => {
                        const completed = (dayEntry.crewTasksCompleted ?? []).includes(task.id);
                        const progress = dayEntry.customTaskProgress?.[task.id] ?? 0;
                        return (
                          <CrewTaskCard
                            key={task.id}
                            task={task}
                            completed={completed}
                            readOnly={readOnly}
                            progress={progress}
                            onToggle={() => {
                              const current = dayEntry.crewTasksCompleted ?? [];
                              wrappedUpdate({ crewTasksCompleted: completed ? current.filter((id) => id !== task.id) : [...current, task.id] });
                            }}
                            onSetProgress={(n) => {
                              const goalAmount = task.amount ?? 0;
                              if (goalAmount <= 0) return;
                              const newProgress = { ...(dayEntry.customTaskProgress ?? {}), [task.id]: n };
                              const current = dayEntry.crewTasksCompleted ?? [];
                              const newCompleted = n >= goalAmount
                                ? current.includes(task.id) ? current : [...current, task.id]
                                : current.filter((id) => id !== task.id);
                              wrappedUpdate({ customTaskProgress: newProgress, crewTasksCompleted: newCompleted });
                            }}
                            onResetProgress={() => {
                              const newProgress = { ...(dayEntry.customTaskProgress ?? {}), [task.id]: 0 };
                              const newCompleted = (dayEntry.crewTasksCompleted ?? []).filter((id) => id !== task.id);
                              wrappedUpdate({ customTaskProgress: newProgress, crewTasksCompleted: newCompleted });
                            }}
                          />
                        );
                      })}
                    </View>
                  </View>
                ))}</View>}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

let _memProfile: UserProfile | null = null;
const SESSION_KEY = 'crewday-profile';

function getBootProfile(): UserProfile | null {
  if (_memProfile) return _memProfile;
  return getSessionCached<UserProfile>(SESSION_KEY);
}

export default function TodayPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(getBootProfile);
  const [error, setError] = useState(false);

  const showLoader = useMinDuration(authLoading || !profile, 600);
  useHideNavWhileLoading(showLoader);

  // Real-time profile subscription — picks up saves from profile screen, points changes, etc.
  useEffect(() => {
    if (!user?.uid) return;
    return subscribeToProfile(user.uid, (fresh) => {
      if (!fresh || fresh.onboardingComplete === false) return;
      _memProfile = fresh;
      setSessionCached(SESSION_KEY, fresh);
      setProfile(fresh);
    });
  }, [user?.uid]);

  useEffect(() => {
    if (!user) {
      _memProfile = null;
      clearAll();
      setProfile(null);
      return;
    }
    const boot = getBootProfile();
    if (boot) {
      if (boot.uid !== user.uid || boot.onboardingComplete === false) {
        _memProfile = null;
        clearAll();
      } else {
        setProfile(boot);
        getUserProfile(user.uid)
          .then((p) => {
            if (p) {
              if (p.onboardingComplete === false) return;
              _memProfile = p; setSessionCached(SESSION_KEY, p); setProfile(p);
            }
          })
          .catch(() => {});
        getAllUsers().catch(() => {});
        getDayHistory(user.uid, 120).catch(() => {});
        return;
      }
    }
    getUserProfile(user.uid)
      .then((p) => {
        if (p) {
          if (p.onboardingComplete === false) { router.replace('/onboarding' as any); return; }
          _memProfile = p; setSessionCached(SESSION_KEY, p); setProfile(p);
        }
        else setError(true);
        getAllUsers().catch(() => {});
        getDayHistory(user.uid, 120).catch(() => {});
      })
      .catch(() => setError(true));
  }, [user]);

  return (
    <>
      {showLoader && <LoadingScreen />}
      {error ? (
        <View style={styles.errorScreen}>
          <Text style={styles.errorScreenText}>Failed to load profile. Check your connection.</Text>
        </View>
      ) : profile && !showLoader ? (
        <TodayInner
          currentUser={profile}
          onProfileUpdate={(updated) => {
            _memProfile = updated;
            setSessionCached(SESSION_KEY, updated);
            setProfile(updated);
          }}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, overflow: 'hidden' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 16,
  },
  hamburgerWrapper: { position: 'relative', marginLeft: 8, flexShrink: 0 },
  hamburger: { flexDirection: 'column', gap: 6, padding: 4, opacity: 0.6 },
  hamburgerLine: { width: 20, height: 2, backgroundColor: colors.text },
  notifDot: {
    position: 'absolute', top: 0, right: 0,
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: colors.red, borderWidth: 1.5, borderColor: colors.bg,
  },
  scrollArea: { flex: 1 },
  scrollContent: { padding: 16 },
  viewingBanner: {
    marginBottom: 8, padding: 8,
    borderWidth: 2, borderColor: colors.border,
    backgroundColor: colors.surface2,
    alignItems: 'center',
  },
  viewingBannerText: { fontFamily: fonts.pixel, fontSize: 6, color: colors.textMuted },
  nudgeQuotaText: { fontFamily: fonts.pixel, fontSize: 5, color: colors.textMuted, marginTop: 2, opacity: 0.7 },
  spendBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center', padding: 32 },
  spendCard: { backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.accent, padding: 24, gap: 16, width: '100%', maxWidth: 416 },
  spendTitle: { fontFamily: fonts.pixel, fontSize: 9, color: colors.accent },
  spendBody: { fontFamily: fonts.pixel, fontSize: 6, color: colors.textMuted, lineHeight: 12 },
  spendBtns: { flexDirection: 'row', gap: 8 },
  spendCancelBtn: { flex: 1, paddingVertical: 10, borderWidth: 2, borderColor: colors.border, alignItems: 'center' },
  spendCancelText: { fontFamily: fonts.pixel, fontSize: 7, color: colors.textMuted },
  spendConfirmBtn: { flex: 1, paddingVertical: 10, borderWidth: 2, borderColor: colors.accent, backgroundColor: colors.accentLight, alignItems: 'center' },
  spendConfirmText: { fontFamily: fonts.pixel, fontSize: 7, color: colors.accent },
  errorBanner: {
    marginBottom: 16, padding: 12,
    borderWidth: 2, borderColor: colors.red,
    backgroundColor: colors.redLight,
    alignItems: 'center',
  },
  errorBannerText: { fontFamily: fonts.pixel, fontSize: 7, color: colors.red },
  content: { gap: 24 },
  dayHeader: { gap: 4 },
  dayHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  dayHeaderLeft: { flex: 1, marginRight: 12 },
  dayNum: {
    fontFamily: fonts.pixel, fontSize: 32, color: colors.accent, lineHeight: 44,
    textShadowColor: colors.accentGlow, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 6,
  },
  startsInLabel: { fontFamily: fonts.pixel, fontSize: 16, color: colors.textMuted, lineHeight: 24 },
  daysUntil: {
    fontFamily: fonts.pixel, fontSize: 28, color: colors.accent, lineHeight: 36, marginTop: 4,
    textShadowColor: colors.accentGlow, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 6,
  },
  dateText: { fontFamily: fonts.pixel, fontSize: 6, color: colors.textMuted },
  dayNumRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  dayNumSmall: {
    fontFamily: fonts.pixel, fontSize: 26, color: colors.accent, lineHeight: 36,
    textShadowColor: colors.accentGlow, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 6,
  },
  generalDate: {
    fontFamily: fonts.vt323, fontSize: 36, color: colors.accent, lineHeight: 40,
    textShadowColor: colors.accentGlow, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 6,
  },
  dayNumSep: { fontFamily: fonts.pixel, fontSize: 20, color: colors.textMuted, lineHeight: 36 },
  generalDayNum: { fontFamily: fonts.pixel, fontSize: 13, color: colors.textMuted, marginTop: 2 },
  sectionToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 10 },
  sectionLabel: { fontFamily: fonts.pixel, fontSize: 10, color: colors.text },
  skeletonContainer: { gap: 12, padding: 4 },
  skeletonHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  skeletonDayNum: { fontFamily: fonts.pixel, fontSize: 32, color: colors.accent, opacity: 0.3, lineHeight: 44 },
  skeletonDate: { fontFamily: fonts.pixel, fontSize: 6, color: colors.textMuted, marginTop: 6 },
  skeletonLabel: { fontFamily: fonts.pixel, fontSize: 9, color: colors.textMuted, opacity: 0.5 },
  skeletonBar: { height: 20, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface },
  skeletonTask: { height: 52, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface },
  errorScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: colors.bg },
  errorScreenText: { fontFamily: fonts.vt323, fontSize: 22, color: colors.red, textAlign: 'center', lineHeight: 32 },

  // Day complete banner
  summaryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.accent,
    ...{ shadowColor: colors.accent, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.35, shadowRadius: 6, elevation: 4 },
  },
  summaryBannerText: {
    fontFamily: fonts.pixel,
    fontSize: 7,
    color: colors.white,
    letterSpacing: 0.3,
  },

  // Crew tasks
  crewTasksSection: { gap: 0 },
  crewTaskGroups: { gap: 16, marginTop: 10 },
  crewTaskGroup: { gap: 8 },
  crewTaskGroupHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  crewTaskGroupName: { fontFamily: fonts.pixel, fontSize: 8, color: colors.textMuted },
  crewTaskList: { gap: 4 },
  crewTaskCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    padding: 12, borderWidth: 2, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  crewTaskBody: { flex: 1, minWidth: 0, gap: 6 },
  crewGoalArea: { gap: 6 },
  crewBarRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  crewBarTrack: { flex: 1, height: 10, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.bg },
  crewBarFill: { height: '100%' },
  crewBarFillAccent: { backgroundColor: colors.accent },
  crewBarFillDone: { backgroundColor: colors.green },
  crewProgressLabel: { fontFamily: fonts.pixel, fontSize: 5, color: colors.textMuted, minWidth: 40, textAlign: 'right' },
  crewProgressLabelDone: { color: colors.green },
  crewSetRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  crewGoalInput: {
    width: 56, fontFamily: fonts.pixel, fontSize: 7,
    borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface2,
    color: colors.text, paddingHorizontal: 6, paddingVertical: 3,
  },
  crewGoalInputError: { borderColor: colors.red },
  crewSetBtn: {
    paddingHorizontal: 8, paddingVertical: 4, borderWidth: 2,
    borderColor: colors.accent, backgroundColor: colors.accentLight,
  },
  crewSetBtnText: { fontFamily: fonts.pixel, fontSize: 5, color: colors.accent },
  crewResetBtn: {
    paddingHorizontal: 8, paddingVertical: 4, borderWidth: 2,
    borderColor: colors.border, backgroundColor: colors.surface2,
  },
  crewResetBtnText: { fontFamily: fonts.pixel, fontSize: 5, color: colors.textMuted },
  crewGoalErrorText: { fontFamily: fonts.pixel, fontSize: 5, color: colors.red },
  crewTaskCardDone: {
    borderColor: colors.green, backgroundColor: colors.greenLight,
    shadowColor: colors.green, shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3, shadowRadius: 6,
  },
  crewCheckbox: {
    width: 22, height: 22, borderWidth: 2, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
    borderColor: colors.textMuted, backgroundColor: 'transparent',
  },
  crewCheckboxDone: {
    borderColor: colors.green, backgroundColor: colors.green,
    shadowColor: colors.green, shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6, shadowRadius: 8,
  },
  crewTaskLabel: {
    fontFamily: fonts.vt323, fontSize: 20, color: colors.text, letterSpacing: 0.4,
  },
  crewTaskLabelDone: {
    color: colors.green, opacity: 0.7, textDecorationLine: 'line-through',
  },
  crewAmountBadge: {
    paddingHorizontal: 5, paddingVertical: 2,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, flexShrink: 0,
  },
  crewAmountText: { fontFamily: fonts.pixel, fontSize: 5, color: colors.text },
});
