import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  writeBatch,
  runTransaction,
  arrayUnion,
  arrayRemove,
  deleteField,
  PartialWithFieldValue,
} from 'firebase/firestore';
import { getFirebaseDb } from './firebase';
import { UserProfile, DayEntry, CustomTask, Crew, CrewTask, CrewDaySummary } from './types';
import { getCached, setCached, invalidate } from './cache';
import { computeStreakFromHistory, computeAllCoreCompleted, computeDayPoints } from './points';
import { differenceInDays, parseISO, format } from 'date-fns';

function db() {
  return getFirebaseDb();
}

function invalidateHistory(uid: string): void {
  invalidate(`history-${uid}-90`);
  invalidate(`history-${uid}-120`);
}

// ── Users ────────────────────────────────────────────────────────────────────

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const key = `profile-${uid}`;
  const cached = getCached<UserProfile>(key);
  if (cached) return cached;
  const snap = await getDoc(doc(db(), 'users', uid));
  const profile = snap.exists() ? (snap.data() as UserProfile) : null;
  if (profile) setCached(key, profile);
  return profile;
}

export async function getAllUsers(): Promise<UserProfile[]> {
  const cached = getCached<UserProfile[]>('all-users');
  if (cached) return cached;
  const snap = await getDocs(collection(db(), 'users'));
  const users = snap.docs.map((d) => d.data() as UserProfile);
  setCached('all-users', users);
  return users;
}

export async function createUserProfile(
  profile: Omit<UserProfile, 'createdAt'>
): Promise<void> {
  await setDoc(doc(db(), 'users', profile.uid), {
    ...profile,
    createdAt: serverTimestamp(),
  });
}

export async function updateUserProfile(
  uid: string,
  updates: Partial<UserProfile>
): Promise<void> {
  await updateDoc(doc(db(), 'users', uid), updates);
  invalidate(`profile-${uid}`);
}

export function subscribeToProfile(
  uid: string,
  onChange: (profile: UserProfile) => void
): () => void {
  return onSnapshot(doc(db(), 'users', uid), (snap) => {
    if (!snap.exists()) return;
    const profile = snap.data() as UserProfile;
    setCached(`profile-${uid}`, profile);
    onChange(profile);
  }, (err) => {
    if (err.code !== 'permission-denied') console.error(err);
  });
}

export async function updateHiddenCoreTasks(
  uid: string,
  hidden: UserProfile['hiddenCoreTasks'],
  currentProfile: UserProfile,
  customTasks: CustomTask[]
): Promise<void> {
  const updates: Record<string, unknown> = { hiddenCoreTasks: hidden ?? deleteField() };
  await updateDoc(doc(db(), 'users', uid), updates);
  invalidate(`profile-${uid}`);

  const today = format(new Date(), 'yyyy-MM-dd');
  const entry = await getDayEntry(uid, today);
  if (!entry) return;
  const updatedProfile = { ...currentProfile, hiddenCoreTasks: hidden };
  const newAllCore = computeAllCoreCompleted(entry, updatedProfile);
  const newPts = computeDayPoints({ ...entry, allCoreCompleted: newAllCore }, customTasks, updatedProfile);
  const delta = newPts - (entry.dailyPoints ?? 0);
  if (newAllCore !== entry.allCoreCompleted || delta !== 0) {
    await updateDayEntryWithPoints(uid, today, { allCoreCompleted: newAllCore, dailyPoints: newPts }, delta);
  }
}

export async function incrementUserPoints(uid: string, delta: number): Promise<void> {
  if (delta === 0) return;
  const userRef = doc(db(), 'users', uid);
  await runTransaction(db(), async (tx) => {
    const snap = await tx.get(userRef);
    const current = (snap.data()?.totalPoints ?? 0) as number;
    tx.update(userRef, { totalPoints: Math.max(0, current + delta) });
  });
  invalidate(`profile-${uid}`);
  invalidate('all-users');
}

export async function getGlobalLeaderboard(): Promise<UserProfile[]> {
  const ref = collection(db(), 'users');
  // Server-side sort + limit avoids a full collection scan
  const q = query(ref, orderBy('totalPoints', 'desc'), limit(50));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => d.data() as UserProfile)
    .filter((u) => u.isActive && u.leaderboardOptOut === false);
}

export async function updateStreakOnProfile(uid: string, challengeStartDate?: string | null): Promise<void> {
  invalidateHistory(uid);
  const history = await getDayHistory(uid, 120);
  const { current, longest } = computeStreakFromHistory(history, challengeStartDate);
  await updateDoc(doc(db(), 'users', uid), { currentStreak: current, longestStreak: longest });
  invalidate(`profile-${uid}`);
  invalidate('all-users');
}

// ── Friends ───────────────────────────────────────────────────────────────────

// Returns true if both sides had pending requests and were auto-accepted as friends.
// The check-and-write is wrapped in a transaction to prevent duplicate outgoing docs
// when two users send each other a request simultaneously.
export async function sendFriendRequest(fromUid: string, toUid: string): Promise<boolean> {
  const mutualRef = doc(db(), 'friendRequests', fromUid, 'incoming', toUid);
  const outgoingRef = doc(db(), 'friendRequests', toUid, 'incoming', fromUid);
  let hasMutual = false;
  await runTransaction(db(), async (tx) => {
    const mutual = await tx.get(mutualRef);
    hasMutual = mutual.exists();
    if (!hasMutual) {
      tx.set(outgoingRef, { fromUid, toUid, createdAt: serverTimestamp() });
    }
  });
  if (hasMutual) {
    await acceptFriendRequest(fromUid, toUid);
    return true;
  }
  return false;
}

export async function getPendingRequests(uid: string): Promise<string[]> {
  const ref = collection(db(), 'friendRequests', uid, 'incoming');
  const snap = await getDocs(ref);
  return snap.docs.map((d) => d.data().fromUid as string);
}

export async function acceptFriendRequest(currentUid: string, fromUid: string): Promise<void> {
  // Commit the friendship first so both users' friends arrays are updated before
  // the Cloud Function fires (which it does when status becomes 'accepted').
  const batch = writeBatch(db());
  batch.update(doc(db(), 'users', currentUid), { friends: arrayUnion(fromUid) });
  batch.update(doc(db(), 'users', fromUid), { friends: arrayUnion(currentUid) });
  await batch.commit();
  await updateDoc(doc(db(), 'friendRequests', currentUid, 'incoming', fromUid), { status: 'accepted' });
  invalidate(`profile-${currentUid}`);
  invalidate(`profile-${fromUid}`);
  invalidate('all-users');
}

export async function declineFriendRequest(currentUid: string, fromUid: string): Promise<void> {
  await deleteDoc(doc(db(), 'friendRequests', currentUid, 'incoming', fromUid));
}

export async function removeFriend(currentUid: string, friendUid: string): Promise<void> {
  const batch = writeBatch(db());
  batch.update(doc(db(), 'users', currentUid), { friends: arrayRemove(friendUid) });
  batch.update(doc(db(), 'users', friendUid), { friends: arrayRemove(currentUid) });
  await batch.commit();
  invalidate(`profile-${currentUid}`);
  invalidate(`profile-${friendUid}`);
  invalidate('all-users');
}

// ── Day Entries ───────────────────────────────────────────────────────────────

export function defaultDayEntry(uid: string, date: string, challengeStartDate: string | null): Omit<DayEntry, 'updatedAt'> {
  const dayNumber = challengeStartDate
    ? differenceInDays(parseISO(date), parseISO(challengeStartDate)) + 1
    : 0;
  return {
    date,
    uid,
    workoutOneCompleted: false,
    workoutOneDuration: 45,
    workoutTwoCompleted: false,
    workoutTwoDuration: 45,
    workoutTwoOutdoor: false,
    dietCompleted: false,
    waterCompleted: false,
    waterOzLogged: 0,
    photoCompleted: false,
    readingCompleted: false,
    pagesRead: 0,
    customTasksCompleted: [],
    crewTasksCompleted: [],
    customTaskProgress: {},
    dayNumber,
    allCoreCompleted: false,
  };
}

export async function getOrCreateDayEntry(
  uid: string,
  date: string,
  challengeStartDate: string | null
): Promise<DayEntry> {
  const ref = doc(db(), 'days', uid, 'entries', date);
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data() as DayEntry;

  const entry = {
    ...defaultDayEntry(uid, date, challengeStartDate),
    updatedAt: serverTimestamp() as Timestamp,
  };
  await setDoc(ref, entry);
  return entry as DayEntry;
}

export async function getDayEntry(uid: string, date: string): Promise<DayEntry | null> {
  const snap = await getDoc(doc(db(), 'days', uid, 'entries', date));
  return snap.exists() ? (snap.data() as DayEntry) : null;
}

export async function updateDayEntry(
  uid: string,
  date: string,
  updates: Partial<DayEntry>
): Promise<void> {
  // Firestore rejects undefined — convert to deleteField() to remove the field
  // Always write date+uid so orderBy('date') queries never miss this document.
  const safe: Record<string, unknown> = { updatedAt: serverTimestamp(), date, uid };
  for (const [k, v] of Object.entries(updates)) {
    safe[k] = v === undefined ? deleteField() : v;
  }
  // Use setDoc+merge instead of updateDoc so this works offline even if the
  // entry was never flushed to Firestore (e.g. first open while offline).
  await setDoc(doc(db(), 'days', uid, 'entries', date), safe as PartialWithFieldValue<DayEntry>, { merge: true });
  invalidateHistory(uid);
}

// Atomically updates a day entry and the user's totalPoints in one transaction,
// flooring totalPoints at 0. Use this for all task-toggle writes.
export async function updateDayEntryWithPoints(
  uid: string,
  date: string,
  updates: Partial<DayEntry>,
  pointsDelta: number,
): Promise<void> {
  const entryRef = doc(db(), 'days', uid, 'entries', date);
  const userRef = doc(db(), 'users', uid);

  // Always write date+uid so orderBy('date') queries never miss this document.
  const safe: Record<string, unknown> = { updatedAt: serverTimestamp(), date, uid };
  for (const [k, v] of Object.entries(updates)) {
    safe[k] = v === undefined ? deleteField() : v;
  }

  if (pointsDelta !== 0) {
    await runTransaction(db(), async (tx) => {
      const userSnap = await tx.get(userRef);
      const current = (userSnap.data()?.totalPoints ?? 0) as number;
      tx.set(entryRef, safe as PartialWithFieldValue<DayEntry>, { merge: true });
      tx.update(userRef, { totalPoints: Math.max(0, current + pointsDelta) });
    });
    invalidate(`profile-${uid}`);
    invalidate('all-users');
  } else {
    await setDoc(entryRef, safe as PartialWithFieldValue<DayEntry>, { merge: true });
  }
  invalidateHistory(uid);
}

// Edits an arbitrary (usually past) day entry, recomputing allCoreCompleted,
// dailyPoints, and the user's streak — used by the History page's day editor
// so backfilled days behave exactly like a same-day edit would have.
export async function editDayEntry(
  uid: string,
  date: string,
  patch: Partial<DayEntry>,
  profile: UserProfile,
  customTasks: CustomTask[]
): Promise<void> {
  const existing = (await getDayEntry(uid, date)) ?? {
    ...defaultDayEntry(uid, date, profile.challengeStartDate),
    updatedAt: Timestamp.now(),
  };
  const merged: DayEntry = { ...existing, ...patch };
  const allCoreCompleted = computeAllCoreCompleted(merged, profile);
  const dailyPoints = computeDayPoints({ ...merged, allCoreCompleted }, customTasks, profile);
  const delta = dailyPoints - (existing.dailyPoints ?? 0);
  await updateDayEntryWithPoints(uid, date, { ...patch, allCoreCompleted, dailyPoints }, delta);
  await updateStreakOnProfile(uid, profile.challengeStartDate);
}

export async function getDayHistory(
  uid: string,
  limitCount = 90
): Promise<DayEntry[]> {
  // Include limitCount in the key so a 90-entry result never masks a 120-entry request
  const key = `history-${uid}-${limitCount}`;
  const cached = getCached<DayEntry[]>(key);
  if (cached) return cached;
  const ref = collection(db(), 'days', uid, 'entries');
  const q = query(ref, orderBy('date', 'desc'), limit(limitCount));
  const snap = await getDocs(q);
  const entries = snap.docs.map((d) => d.data() as DayEntry);
  setCached(key, entries);
  return entries;
}

// ── Custom Tasks ──────────────────────────────────────────────────────────────

export async function getCustomTasks(uid: string): Promise<CustomTask[]> {
  const ref = collection(db(), 'customTasks', uid, 'tasks');
  const q = query(ref, orderBy('order', 'asc'));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as CustomTask);
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function createCustomTask(
  task: Omit<CustomTask, 'id' | 'createdAt'>
): Promise<void> {
  const ref = doc(collection(db(), 'customTasks', task.uid, 'tasks'));
  await setDoc(ref, { ...stripUndefined(task), id: ref.id, createdAt: serverTimestamp() });
}

export async function updateCustomTask(
  uid: string,
  taskId: string,
  updates: Partial<CustomTask>
): Promise<void> {
  const cleaned = Object.fromEntries(
    Object.entries(updates).map(([k, v]) => [k, v === undefined ? deleteField() : v])
  );
  await updateDoc(doc(db(), 'customTasks', uid, 'tasks', taskId), cleaned);
}

export async function archiveCustomTask(
  uid: string,
  taskId: string
): Promise<void> {
  await updateDoc(doc(db(), 'customTasks', uid, 'tasks', taskId), {
    archived: true,
  });
}

export async function reorderCustomTasks(
  uid: string,
  orderedIds: string[]
): Promise<void> {
  const batch = writeBatch(db());
  orderedIds.forEach((id, index) => {
    batch.update(doc(db(), 'customTasks', uid, 'tasks', id), { order: index });
  });
  await batch.commit();
}

// ── Crews ─────────────────────────────────────────────────────────────────────

function generateJoinCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export async function getCrewById(crewId: string): Promise<Crew | null> {
  const key = `crew-${crewId}`;
  const cached = getCached<Crew>(key);
  if (cached) return cached;
  const snap = await getDoc(doc(db(), 'crews', crewId));
  const crew = snap.exists() ? (snap.data() as Crew) : null;
  if (crew) setCached(key, crew);
  return crew;
}

export async function getUserCrews(uid: string): Promise<Crew[]> {
  const key = `crews-${uid}`;
  const cached = getCached<Crew[]>(key);
  if (cached) return cached;
  const q = query(collection(db(), 'crews'), where('members', 'array-contains', uid));
  const snap = await getDocs(q);
  const crews = snap.docs.map((d) => d.data() as Crew);
  setCached(key, crews);
  return crews;
}

export function invalidateUserCrews(uid: string): void {
  invalidate(`crews-${uid}`);
}

export async function getCrewSummary(crewId: string, date: string): Promise<CrewDaySummary | null> {
  const snap = await getDoc(doc(db(), 'crews', crewId, 'summaries', date));
  return snap.exists() ? (snap.data() as CrewDaySummary) : null;
}

export async function createCrew(
  crew: Omit<Crew, 'id' | 'createdAt'>,
  creatorUid: string
): Promise<string> {
  const joinCode = generateJoinCode();
  const ref = doc(collection(db(), 'crews'));
  await setDoc(ref, { ...crew, id: ref.id, joinCode, createdAt: serverTimestamp() });
  await setDoc(doc(db(), 'users', creatorUid), { crews: arrayUnion(ref.id) }, { merge: true });
  invalidate(`crews-${creatorUid}`);
  invalidate(`profile-${creatorUid}`);
  return ref.id;
}

export async function updateCrewName(crewId: string, name: string): Promise<void> {
  await setDoc(doc(db(), 'crews', crewId), { name }, { merge: true });
  invalidate(`crew-${crewId}`);
}

export async function updateCrewIcon(crewId: string, icon: string): Promise<void> {
  await setDoc(doc(db(), 'crews', crewId), { icon }, { merge: true });
  invalidate(`crew-${crewId}`);
}

export async function updateCrewActiveTasks(
  crewId: string,
  activeTasks: Crew['activeTasks']
): Promise<void> {
  await setDoc(doc(db(), 'crews', crewId), { activeTasks }, { merge: true });
  invalidate(`crew-${crewId}`);
}

export async function addCrewCustomTask(crewId: string, task: CrewTask): Promise<void> {
  const crew = await getCrewById(crewId);
  if (!crew) throw new Error('Crew not found');
  const updated = [...crew.customCrewTasks, task];
  await setDoc(doc(db(), 'crews', crewId), { customCrewTasks: updated }, { merge: true });
  invalidate(`crew-${crewId}`);
}

export async function removeCrewCustomTask(crewId: string, taskId: string): Promise<void> {
  const crew = await getCrewById(crewId);
  if (!crew) throw new Error('Crew not found');
  const updated = crew.customCrewTasks.filter((t) => t.id !== taskId);
  await setDoc(doc(db(), 'crews', crewId), { customCrewTasks: updated }, { merge: true });
  invalidate(`crew-${crewId}`);
}

export async function promoteToAdmin(crewId: string, targetUid: string): Promise<void> {
  await setDoc(doc(db(), 'crews', crewId), { admins: arrayUnion(targetUid) }, { merge: true });
  invalidate(`crew-${crewId}`);
}

export async function demoteFromAdmin(crewId: string, targetUid: string): Promise<void> {
  await setDoc(doc(db(), 'crews', crewId), { admins: arrayRemove(targetUid) }, { merge: true });
  invalidate(`crew-${crewId}`);
}

export function subscribeToCrewById(
  crewId: string,
  onChange: (crew: Crew) => void
): () => void {
  return onSnapshot(doc(db(), 'crews', crewId), (snap) => {
    if (!snap.exists()) return;
    const crew = snap.data() as Crew;
    setCached(`crew-${crewId}`, crew);
    onChange(crew);
  }, (err) => {
    if (err.code !== 'permission-denied') console.error(err);
  });
}
