import { useEffect, useRef, useState } from 'react'
import {
  Bell, Briefcase, Check, ChevronLeft, ChevronRight, Clock3, Download,
  Home, MapPin, Moon, QrCode, RefreshCw, ScanLine, Smartphone,
  ShieldCheck, Sun, X,
} from 'lucide-react'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import QRCode from 'qrcode'
import './App.css'

const OFFICE_ADDRESS_FALLBACK = 'First Floor, 28-1, Jln 1/116B, Sri Desa Entrepreneur Park'
// Bootstrap default only, for the brief window before /api/me resolves --
// the real, current value (which an admin can change) is me.office.qr.
// Using a stale hardcoded value here would make scanning fail right after
// a regenerate, since this constant would no longer match the printed code.
const QR_PAYLOAD_FALLBACK = 'Rizurf_Attandance'
// Public VAPID key -- safe to expose client-side by design, it's how the
// browser verifies a push came from our server, not a secret. Paired with
// VAPID_PRIVATE_KEY server-side; regenerate both together or subscriptions
// silently stop working.
const VAPID_PUBLIC_KEY = 'BEmUTTBYoJ6HqcdHvtqY_Nlxw6E22xYQfBrB48anQ8lCMVhQSMMBM6SNEu1HVO32bW9VtV4sAZ7bFHagcZrTMak'

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
}

function initialsOf(name) {
  return (name || '').trim().split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase() || 'RZ'
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate(date) {
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: '2-digit' })
}

// iOS only exposes the Push API to a PWA that's been added to the Home
// Screen (Share -> Add to Home Screen) -- a regular Safari tab can request
// permission and even appear to subscribe, then silently never receive a
// single push. iPadOS 13+ reports as "Macintosh" in the UA, hence the touch
// check to tell it apart from an actual Mac.
function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches
}

function todayIsoDate() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function formatMonthLabel(monthStr) {
  const [year, month] = monthStr.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })
}

// Weeks of a calendar month grid, Monday-first, padded with the adjacent
// months' days (shown faded) so every week is full.
function buildMonthGrid(monthStr) {
  const [year, month] = monthStr.split('-').map(Number)
  const first = new Date(year, month - 1, 1)
  const cursor = new Date(year, month - 1, 1 - ((first.getDay() + 6) % 7))
  const weeks = []
  do {
    const week = []
    for (let i = 0; i < 7; i++) {
      week.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`)
      cursor.setDate(cursor.getDate() + 1)
    }
    weeks.push(week)
  } while (cursor.getMonth() === month - 1)
  return weeks
}

function statusDotClass(status) {
  if (status === 'Late') return 'late'
  if (status === 'Excused (MC)') return 'excused'
  return 'ontime'
}

// One admin-calendar day cell. Filtered to one intern, it shows that day's
// actual status as a dot (like the intern's own calendar); otherwise it
// shows a count, which switches to just the late/on-time count when a
// status filter is active (dimming days that don't have any, so a month
// full of late days jumps out at a glance).
const STATUS_LABELS = { 'On time': 'On time', Late: 'Late', 'Excused (MC)': 'MC' }

function statusChip(status) {
  return { label: STATUS_LABELS[status] || status, kind: statusDotClass(status) }
}

// Admin cell chips: that intern's status when filtered to one person,
// otherwise the day's counts (just the chosen status when one is picked).
function adminDayChips(dayData, filterIntern, statusFilter) {
  if (!dayData) return []
  if (filterIntern) return [statusChip(dayData.status)]
  const excused = dayData.total - dayData.late - dayData.onTime
  return [
    (!statusFilter || statusFilter === 'On time') && dayData.onTime > 0 && { label: `${dayData.onTime} on time`, kind: 'ontime' },
    (!statusFilter || statusFilter === 'Late') && dayData.late > 0 && { label: `${dayData.late} late`, kind: 'late' },
    !statusFilter && excused > 0 && { label: `${excused} MC`, kind: 'excused' },
  ].filter(Boolean)
}

// One cell, phone-calendar style: the date, then coloured chips. Days of the
// adjacent months are faded and inert -- their data isn't loaded.
function CalendarDay({ date, month, isToday, isSelected, dimmed, holidayName, chips, onSelect }) {
  const outside = date.slice(0, 7) !== month
  const className = [
    'admin-calendar-day',
    outside && 'outside',
    isToday && 'is-today',
    isSelected && 'selected',
    dimmed && 'dimmed',
    new Date(`${date}T00:00:00`).getDay() === 0 && 'sunday',
  ].filter(Boolean).join(' ')
  return (
    <button className={className} disabled={outside} onClick={() => onSelect(date)}>
      <span className="admin-calendar-daynum">{Number(date.slice(8, 10))}</span>
      {!outside && holidayName && <span className="cal-chip holiday">{holidayName}</span>}
      {!outside && chips.map((chip) => <span key={chip.label} className={`cal-chip ${chip.kind}`}>{chip.label}</span>)}
    </button>
  )
}

const CALENDAR_WEEKDAYS = <div className="admin-calendar-weekdays"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span className="sunday">S</span></div>

function CalendarLegend() {
  return (
    <div className="cal-legend">
      {[['holiday', 'Holiday'], ['ontime', 'On time'], ['late', 'Late'], ['excused', 'MC']].map(([kind, label]) => (
        <span key={kind}><i className={`cal-swatch ${kind}`}></i>{label}</span>
      ))}
    </div>
  )
}

function SkeletonLine({ width, height = 14, style }) {
  return <span className="skeleton skeleton-line" style={{ width, height, ...style }}></span>
}

function ProfileChipSkeleton() {
  return <span className="profile-chip"><span className="skeleton skeleton-circle avatar"></span><SkeletonLine width={72} height={11} style={{ marginLeft: 4 }} /></span>
}

function WelcomeRowSkeleton() {
  return <section className="welcome-row"><div><SkeletonLine width={90} height={11} style={{ marginBottom: 12 }} /><SkeletonLine width={230} height={30} style={{ marginBottom: 10 }} /><SkeletonLine width={200} height={14} /></div><span className="skeleton skeleton-pill" style={{ width: 150, height: 34 }}></span></section>
}

function HeroSkeleton() {
  return <div className="hero-copy"><SkeletonLine width={110} height={10} style={{ marginBottom: 14 }} /><SkeletonLine width={220} height={26} style={{ marginBottom: 12 }} /><SkeletonLine width={260} height={13} style={{ marginBottom: 22 }} /><span className="skeleton skeleton-pill" style={{ width: 140, height: 42 }}></span></div>
}

function MetricCardSkeleton() {
  return <article className="metric-card"><span className="skeleton skeleton-circle" style={{ width: 36, height: 36 }}></span><div><SkeletonLine width={70} height={11} style={{ marginBottom: 8 }} /><SkeletonLine width={50} height={20} /></div></article>
}

function HistoryRowSkeleton() {
  return <div className="history-row"><div className="history-date"><SkeletonLine width={40} height={11} style={{ marginBottom: 4 }} /><SkeletonLine width={55} height={10} /></div><div className="history-times"><SkeletonLine width={60} height={11} style={{ marginBottom: 4 }} /><SkeletonLine width={70} height={10} /></div><SkeletonLine width={45} height={10} /><span className="skeleton skeleton-pill" style={{ width: 50, height: 20 }}></span></div>
}

function App() {
  const [activeTab, setActiveTab] = useState('home')
  const [notice, setNotice] = useState(null)
  const [history, setHistory] = useState([])
  const [today, setToday] = useState(null)
  const [modal, setModal] = useState(null)
  const [scannerError, setScannerError] = useState('')
  const [scanStatus, setScanStatus] = useState('')
  const [profileOpen, setProfileOpen] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [me, setMe] = useState(null)
  const [meLoaded, setMeLoaded] = useState(false)
  const [attendanceLoaded, setAttendanceLoaded] = useState(false)
  const [devices, setDevices] = useState([])
  const [historyMonth, setHistoryMonth] = useState(() => todayIsoDate().slice(0, 7))
  const [historyMonthRecords, setHistoryMonthRecords] = useState([])
  const [historyMonthLoading, setHistoryMonthLoading] = useState(false)
  const [adminDate, setAdminDate] = useState(todayIsoDate)
  const [adminRecords, setAdminRecords] = useState([])
  const [scheduledMode, setScheduledMode] = useState(null)
  const [historyDetail, setHistoryDetail] = useState(null)
  const [adminInterns, setAdminInterns] = useState([])
  const [adminInternQuery, setAdminInternQuery] = useState('')
  const [adminLoading, setAdminLoading] = useState(false)
  const [adminMonthRecords, setAdminMonthRecords] = useState([])
  const [adminMonthLoading, setAdminMonthLoading] = useState(false)
  const [adminCalendarMonth, setAdminCalendarMonth] = useState(() => todayIsoDate().slice(0, 7))
  const [adminCalendarDays, setAdminCalendarDays] = useState([])
  const [adminHolidays, setAdminHolidays] = useState({})
  const [historyHolidays, setHistoryHolidays] = useState({})
  const [adminFilterIntern, setAdminFilterIntern] = useState(null)
  const [adminStatusFilter, setAdminStatusFilter] = useState(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [avatarFailed, setAvatarFailed] = useState(false)
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem('rizurf-theme')
    if (stored === 'light' || stored === 'dark') return stored
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const locationRef = useRef(null)
  const scannerRef = useRef(null)
  const scanHandledRef = useRef(false)

  const isClockedIn = Boolean(today?.clockIn && !today?.clockOut)
  const action = isClockedIn ? 'out' : 'in'
  const showNotice = (type, message) => setNotice({ type, message })

  useEffect(() => {
    fetch('./api/me.php')
      .then((response) => response.json())
      .then((data) => { if (!data.error) setMe(data) })
      .catch(() => {})
      .finally(() => setMeLoaded(true))
  }, [])

  useEffect(() => {
    fetch('./api/attendance.php')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message || data.error?.message || 'Could not load your attendance.')
        setHistory(data.records || [])
        setToday(data.today || null)
        setScheduledMode(data.scheduledMode || null)
      })
      .catch((error) => showNotice('error', error.message || 'Could not load your attendance history.'))
      .finally(() => setAttendanceLoaded(true))
  }, [])

  const showSkeleton = !meLoaded || !attendanceLoaded

  const loadDevices = () => fetch('./api/devices.php')
    .then((response) => response.json())
    .then((data) => { if (data.success) setDevices(data.devices) })
    .catch(() => {})

  useEffect(() => { loadDevices() }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('rizurf-theme', theme)
  }, [theme])

  const toggleTheme = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))

  // On load, reflect whatever this browser actually has -- not a guess --
  // since a subscription can be dropped by the browser itself (e.g. site
  // data cleared) without the app ever being told.
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setNotificationsEnabled(Boolean(subscription)))
      .catch(() => {})
  }, [])

  const enableNotifications = async () => {
    if (isIos() && !isStandalone()) {
      showNotice('error', 'On iPhone/iPad, reminders only work once this app is added to your Home Screen. Tap the Share icon, choose "Add to Home Screen", then open it from there and try again.')
      return
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      showNotice('error', 'Notifications are not supported in this browser.')
      return
    }
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        showNotice('error', 'Notification permission was blocked. Allow it for this site to turn reminders on.')
        return
      }
      const registration = await navigator.serviceWorker.ready
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        })
      }
      const response = await fetch('./api/subscribe.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      })
      const data = await response.json()
      if (!data.success) throw new Error(data.message)
      setNotificationsEnabled(true)
      showNotice('success', 'Clock in/out reminders are on.')
    } catch (error) {
      showNotice('error', error.message || 'Could not turn on notifications.')
    }
  }

  const disableNotifications = async () => {
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        await fetch('./api/subscribe.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unsubscribe', endpoint: subscription.endpoint }),
        })
        await subscription.unsubscribe()
      }
      setNotificationsEnabled(false)
      showNotice('success', 'Clock in/out reminders are off.')
    } catch {
      showNotice('error', 'Could not turn off notifications.')
    }
  }

  const toggleNotifications = () => (notificationsEnabled ? disableNotifications() : enableNotifications())

  // Unlinks one device from your account -- any device in the list, not
  // just the one you're using right now (e.g. logging out an old phone
  // remotely), the way WhatsApp's own linked-devices list works. Not a way
  // to bump someone else off their own device: the server only ever removes
  // a device that's actually yours.
  const unlinkDevice = (deviceId) => {
    fetch('./api/devices.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId }) })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setDevices(data.devices)
        showNotice('success', 'That device has been unlinked.')
      })
      .catch((error) => showNotice('error', error.message || 'Could not unlink that device.'))
  }

  const completeAttendance = (mode) => {
    const now = new Date()
    const time = formatTime(now)
    const payload = { action, mode, qrToken: mode === 'Office' ? currentQr : null, latitude: window.lastAttendanceLatitude || null, longitude: window.lastAttendanceLongitude || null, accuracy: window.lastAttendanceAccuracy || null }
    fetch('./api/attendance.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setToday(data.today)
        setHistory(data.records)
        loadDevices()
        showNotice('success', `${action === 'in' ? 'Clocked in' : 'Clocked out'} at ${time} via ${mode}. ${data.message}`)
        setModal(null)
        setScannerError('')
        setScanStatus('')
        window.history.replaceState(null, '', `${window.location.pathname}#overview`)
        window.scrollTo({ top: 0, behavior: 'smooth' })
      })
      .catch((error) => {
        setScanStatus('')
        if (mode === 'Office') {
          setScannerError(error.message || 'Attendance could not be saved.')
        } else {
          showNotice('error', error.message || 'Attendance could not be saved.')
        }
      })
  }

  const chooseMode = (mode) => {
    if (mode === 'Hybrid') {
      completeAttendance('Hybrid')
      return
    }
    setScannerError('')
    setScanStatus('')
    scanHandledRef.current = false
    locationRef.current = getCurrentLocation()
    setModal('scan')
  }

  const getCurrentLocation = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location services are not available in this browser.'))
      return
    }
    navigator.geolocation.getCurrentPosition(({ coords }) => resolve(coords), (error) => {
      reject(new Error(error.code === 1
        ? 'Location permission was blocked. Allow location access for this site and scan again.'
        : 'Location took too long. Turn on phone location services and try again, or choose Hybrid.'))
    }, { enableHighAccuracy: false, timeout: 6000, maximumAge: 30000 })
  })

  const verifyOfficeLocation = () => {
    setScannerError('')
    setScanStatus('QR accepted. Saving attendance...')
    const locationPromise = locationRef.current || getCurrentLocation()
    locationPromise.then((coords) => {
      window.lastAttendanceLatitude = coords.latitude
      window.lastAttendanceLongitude = coords.longitude
      window.lastAttendanceAccuracy = coords.accuracy
      completeAttendance('Office')
    }).catch((error) => {
      setScanStatus('')
      setScannerError(error.message)
    })
  }

  const stopScanner = async () => {
    const scanner = scannerRef.current
    scannerRef.current = null
    if (!scanner) return
    try { await scanner.stop() } catch { /* scanner may already be stopped */ }
    try { scanner.clear() } catch { /* camera element may already be cleared */ }
  }

  const startScanner = async () => {
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      setScannerError('Camera scanning requires HTTPS on a phone. Choose Hybrid instead.')
      return
    }
    // QR only (the default tries every barcode format on every frame), and
    // the browser's native detector where it has one (Chrome on Android).
    const scanner = new Html5Qrcode('qr-reader', {
      formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
      useBarCodeDetectorIfSupported: true,
      verbose: false,
    })
    scannerRef.current = scanner
    const config = { fps: 20, qrbox: { width: 220, height: 220 } }
    const onDecoded = (decodedText) => {
      if (scanHandledRef.current) return
      if (decodedText.trim() !== currentQr) {
        setScannerError(`QR read as “${decodedText.trim()}”, but the expected value is “${currentQr}”.`)
        return
      }
      scanHandledRef.current = true
      stopScanner()
      verifyOfficeLocation()
    }

    try {
      await scanner.start({ facingMode: 'environment' }, config, onDecoded, () => {})
      return
    } catch (error) {
      if (error?.name === 'NotAllowedError') {
        setScannerError('Camera access was blocked. Allow camera permission for this site, then try again.')
        return
      }
      // Some Android browsers (seen on Honor/Huawei devices) reject a bare
      // facingMode constraint outright -- before ever prompting for
      // permission -- because they can't resolve which physical camera
      // satisfies it. Falling back to an explicit camera id, picked from
      // the device's own enumeration, is html5-qrcode's own documented
      // workaround for this exact class of device.
    }
    try {
      const cameras = await Html5Qrcode.getCameras()
      if (!cameras.length) {
        setScannerError('No camera was found on this device. Choose Hybrid instead.')
        return
      }
      const rearCamera = cameras.find((camera) => /back|rear|environment/i.test(camera.label)) || cameras[cameras.length - 1]
      await scanner.start(rearCamera.id, config, onDecoded, () => {})
    } catch (error) {
      setScannerError(error?.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow camera permission for this site, then try again.'
        : 'Could not start the camera on this device. Choose Hybrid instead.')
    }
  }


  const openAttendance = () => {
    setScannerError('')
    // Clock-out must use the same mode you clocked in with -- the backend
    // enforces this and rejects a mismatch, so there's no real choice to
    // offer here; skip straight to whichever mode that actually is instead
    // of showing a picker where one of the two options is guaranteed to fail.
    if (isClockedIn && today?.mode) {
      chooseMode(today.mode)
      return
    }
    setModal('mode')
  }

  const openScanner = () => {
    setActiveTab('home')
    setScannerError('')
    setScanStatus('')
    scanHandledRef.current = false
    locationRef.current = getCurrentLocation()
    setModal('scan')
  }

  const selectTab = (tab) => {
    if (tab === 'scan') {
      openScanner()
      return
    }
    if (tab === 'profile') {
      setProfileOpen(true)
      return
    }
    setActiveTab(tab)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const intern = me?.intern || null
  const notLinked = Boolean(me && me.linked === false)
  const displayName = intern ? `${intern.first_name} ${intern.last_name}` : (me?.name || 'Intern')
  const firstName = (intern?.first_name || me?.name || 'there').split(' ')[0]
  const initials = intern ? initialsOf(`${intern.first_name} ${intern.last_name}`) : initialsOf(me?.name)
  const photoUrl = intern?.photo_url && !avatarFailed ? intern.photo_url : null
  const officeAddress = me?.office?.address || OFFICE_ADDRESS_FALLBACK
  const currentQr = me?.office?.qr || QR_PAYLOAD_FALLBACK
  const isAdmin = me?.role === 'admin'

  const loadAdminAttendance = (date) => {
    setAdminLoading(true)
    fetch(`./api/admin/attendance.php?date=${date}`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setAdminRecords(data.records)
      })
      .catch((error) => showNotice('error', error.message || 'Could not load attendance for that date.'))
      .finally(() => setAdminLoading(false))
  }

  const loadAdminCalendar = (month, internId) => {
    const query = internId ? `month=${month}&intern=${internId}` : `month=${month}`
    fetch(`./api/admin/attendance-calendar.php?${query}`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setAdminCalendarDays(data.days)
        setAdminHolidays(data.holidays || {})
      })
      .catch(() => {}) // best-effort -- day badges just stay empty, the list below still works
  }

  const shiftAdminMonth = (delta) => {
    const [year, month] = adminCalendarMonth.split('-').map(Number)
    const next = new Date(year, month - 1 + delta, 1)
    setAdminCalendarMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`)
  }

  // Every matching record for the whole month, not just the selected day --
  // what the Late/On time toggle actually shows once active.
  const loadAdminMonthRecords = (month, status, internId) => {
    setAdminMonthLoading(true)
    const query = new URLSearchParams({ month })
    if (status) query.set('status', status)
    if (internId) query.set('intern', internId)
    fetch(`./api/admin/attendance.php?${query}`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setAdminMonthRecords(data.records)
      })
      .catch((error) => showNotice('error', error.message || 'Could not load this month.'))
      .finally(() => setAdminMonthLoading(false))
  }

  // Clicking the already-filtered intern's name again clears the filter.
  const toggleAdminFilterIntern = (record) => {
    const next = adminFilterIntern?.id === record.internId ? null : { id: record.internId, name: record.internName }
    setAdminFilterIntern(next)
    setAdminInternQuery(next?.name || '')
  }

  const loadHistoryMonth = (month) => {
    setHistoryMonthLoading(true)
    fetch(`./api/attendance.php?month=${month}`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setHistoryMonthRecords(data.records)
        setHistoryHolidays(data.holidays || {})
      })
      .catch((error) => showNotice('error', error.message || 'Could not load that month.'))
      .finally(() => setHistoryMonthLoading(false))
  }

  const shiftHistoryMonth = (delta) => {
    const [year, month] = historyMonth.split('-').map(Number)
    const next = new Date(year, month - 1 + delta, 1)
    setHistoryMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`)
  }

  /* oxlint-disable react-hooks/exhaustive-deps, react(set-state-in-effect) */
  useEffect(() => {
    if (isAdmin && activeTab === 'admin') loadAdminAttendance(adminDate)
  }, [isAdmin, activeTab, adminDate])
  useEffect(() => {
    if (isAdmin && activeTab === 'admin') loadAdminCalendar(adminCalendarMonth, adminFilterIntern?.id)
  }, [isAdmin, activeTab, adminCalendarMonth, adminFilterIntern])
  useEffect(() => {
    if (isAdmin && activeTab === 'admin' && (adminStatusFilter || adminFilterIntern)) {
      loadAdminMonthRecords(adminCalendarMonth, adminStatusFilter, adminFilterIntern?.id)
    }
  }, [isAdmin, activeTab, adminCalendarMonth, adminStatusFilter, adminFilterIntern])
  useEffect(() => {
    if (isAdmin && activeTab === 'admin' && adminInterns.length === 0) {
      fetch('./api/admin/attendance.php?interns=1')
        .then((response) => response.json())
        .then((data) => { if (data.success) setAdminInterns(data.interns) })
        .catch(() => {}) // best-effort -- clicking a name in the list still filters
    }
  }, [isAdmin, activeTab])
  useEffect(() => {
    if (activeTab === 'history') loadHistoryMonth(historyMonth)
  }, [activeTab, historyMonth])
  /* oxlint-enable react-hooks/exhaustive-deps, react(set-state-in-effect) */

  const adminCalendarWeeks = buildMonthGrid(adminCalendarMonth)
  const adminCalendarByDate = Object.fromEntries(adminCalendarDays.map((day) => [day.date, day]))
  const historyWeeks = buildMonthGrid(historyMonth)
  const historyByDate = Object.fromEntries(historyMonthRecords.map((record) => [record.rawDate, record]))
  const todayDate = todayIsoDate()
  // A status or intern filter -> every matching record for the whole month
  // (filtered server-side). Otherwise -> just the selected day.
  const adminMonthView = Boolean(adminStatusFilter || adminFilterIntern)
  const visibleAdminRecords = adminMonthView ? adminMonthRecords : adminRecords

  // Mirrors whatever's currently on screen -- same month, same Late/On time
  // and intern filters if any are active, just as a CSV instead of JSON.
  const adminExportParams = new URLSearchParams({ month: adminCalendarMonth, format: 'csv' })
  if (adminStatusFilter) adminExportParams.set('status', adminStatusFilter)
  if (adminFilterIntern) adminExportParams.set('intern', adminFilterIntern.id)
  const adminExportUrl = `./api/admin/attendance.php?${adminExportParams}`
  // A bare `download` attribute lets the browser guess a filename from the
  // URL instead of the server's Content-Disposition -- naming it explicitly
  // here guarantees it, regardless of that per-browser fallback behavior.
  const adminExportFilename = `attendance-${adminCalendarMonth}${adminStatusFilter ? `-${adminStatusFilter.toLowerCase().replace(' ', '-')}` : ''}.csv`

  // The QR image is rendered client-side from whatever the current code
  // actually is -- never a separate fetch, so it can never drift from what
  // /api/me already says (and what attendance.php will actually accept).
  useEffect(() => {
    QRCode.toDataURL(currentQr, { margin: 1, width: 220 }).then(setQrDataUrl).catch(() => setQrDataUrl(''))
  }, [currentQr])

  // Retry a fresh photo_url (e.g. after re-signing in) instead of staying
  // stuck on initials because an earlier, different URL once failed to load.
  useEffect(() => {
    setAvatarFailed(false)
  }, [intern?.photo_url])

  const regenerateQr = () => {
    fetch('./api/admin/qr.php', { method: 'POST' })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setMe((previous) => (previous ? { ...previous, office: { ...previous.office, qr: data.qr } } : previous))
        showNotice('success', 'Office QR regenerated. Update the printed/displayed code now -- the old one no longer works.')
      })
      .catch((error) => showNotice('error', error.message || 'Could not regenerate the office QR.'))
  }

  // A larger, print-friendly render of the same code the admin is currently
  // looking at -- generated on demand rather than reusing the 220px on-screen
  // image, so the saved file still looks sharp at office-sign size.
  const downloadQr = () => {
    QRCode.toDataURL(currentQr, { margin: 2, width: 512 })
      .then((url) => {
        const link = document.createElement('a')
        link.href = url
        link.download = `rizurf-office-qr-${new Date().toISOString().slice(0, 10)}.png`
        link.click()
      })
      .catch(() => showNotice('error', 'Could not save the QR image.'))
  }

  /* oxlint-disable react-hooks/exhaustive-deps, react(set-state-in-effect) */
  useEffect(() => {
    if (modal === 'scan') startScanner()
    return () => { stopScanner() }
  }, [modal])
  /* oxlint-enable react-hooks/exhaustive-deps, react(set-state-in-effect) */

  return (
    <div className="app-shell">
      <header className="topbar">
        <img src={theme === 'dark' ? './rizurf-logo-dark.png' : './rizurf-logo-light.png'} alt="Rizurf Realty" className="topbar-logo" />
        <div className="topbar-actions"><span className="system-status"><i></i> All systems operational</span><button className="icon-button" aria-label="Refresh" title="Refresh" onClick={() => window.location.reload()}><RefreshCw size={19} /></button>{meLoaded ? <button className="profile-chip" aria-label="Open profile" onClick={() => selectTab('profile')}>{photoUrl ? <img src={photoUrl} alt="" className="avatar" onError={() => setAvatarFailed(true)} /> : <span className="avatar">{initials}</span>}<span className="profile-name">{displayName}</span><ChevronRight size={15} /></button> : <ProfileChipSkeleton />}</div>
      </header>

      <main id="overview" className={`tab-content ${activeTab}-tab`}>
        {showSkeleton ? <WelcomeRowSkeleton /> : <section className="welcome-row"><div><p className="eyebrow">{formatDate(new Date())}</p><h1>Good morning, {firstName}</h1><p className="subtitle">Record your workday in a few seconds.</p></div><div className="location-pill"><Briefcase size={15} /> {intern?.department_name || 'Rizurf'}</div></section>}
        {notLinked && <div className="notice error" role="status"><X size={17} />{me.reason === 'lookup_failed'
          ? `Could not reach the Intern Database${me.detail ? ` (${me.detail})` : ''}. Your attendance will load once it is back.`
          : `Your Rizurf account${me?.email ? ` (${me.email})` : ''} isn't linked to an intern record yet. Ask an admin to add you in the Intern Database.`}</div>}
        {notice && <div className={`notice ${notice.type}`} role="status">{notice.type === 'success' ? <Check size={17} /> : <X size={17} />}{notice.message}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={15} /></button></div>}

        <section className="attendance-hero">{showSkeleton ? <HeroSkeleton /> : <div className="hero-copy"><p className="eyebrow">TODAY'S ATTENDANCE</p><h2>{isClockedIn ? 'You are clocked in' : today?.clockOut ? 'Workday complete' : 'Ready to clock in?'}</h2><p>{isClockedIn ? `Started at ${today.clockIn} via ${today.mode}. Clock out when you finish.` : today?.clockOut ? `Clocked out at ${today.clockOut} via ${today.clockOutMode || today.mode}.` : 'Choose Office if you are at work, or Hybrid if you are working away.'}</p><div className="attendance-actions"><button className={today?.clockOut ? 'primary-button checked-in' : 'primary-button'} onClick={openAttendance} disabled={Boolean(today?.clockOut)}>{today?.clockOut ? <><Check size={18} /> Attendance complete</> : <><Clock3 size={18} /> Clock {action}</>}</button></div><span className="location-note"><ShieldCheck size={14} /> Office location within 100m · Mobile data supported</span></div>}<div className="hero-location"><div className="location-orbit"><MapPin size={35} /></div><strong>Office verification</strong><span>100m radius from the office</span><small>{officeAddress}</small></div></section>

        <section className="quick-grid">{showSkeleton ? <><MetricCardSkeleton /><MetricCardSkeleton /></> : <><article className="metric-card accent-card"><div className="metric-icon"><Clock3 size={19} /></div><div><p>Late arrivals</p><strong>{history.filter((entry) => entry.status === 'Late').length} <small>times</small></strong><em>This month</em></div></article><article className="metric-card"><div className="metric-icon pale"><Clock3 size={19} /></div><div><p>Today</p><strong>{today?.clockIn || '—'} <small>{today?.clockOut ? `to ${today.clockOut}` : '/ pending'}</small></strong><em>{today?.mode || 'No attendance recorded yet'}</em></div></article></>}</section>

        {activeTab === 'history' && <section className="tab-panel logs-panel"><div className="tab-heading"><p className="eyebrow">ATTENDANCE LOGS</p><h1>My attendance history</h1><p>Clock-ins, clock-outs, late arrivals, and grace-period records.</p></div><article className="activity-card"><div className="admin-calendar"><div className="admin-calendar-header"><button className="icon-button" aria-label="Previous month" onClick={() => shiftHistoryMonth(-1)}><ChevronLeft size={18} /></button><strong>{formatMonthLabel(historyMonth)}</strong><button className="icon-button" aria-label="Next month" onClick={() => shiftHistoryMonth(1)}><ChevronRight size={18} /></button></div>{CALENDAR_WEEKDAYS}<div className="admin-calendar-grid">{historyWeeks.flat().map((date) => <CalendarDay key={date} date={date} month={historyMonth} isToday={date === todayDate} isSelected={date === historyDetail} holidayName={historyHolidays[date]} chips={historyByDate[date] ? [statusChip(historyByDate[date].status)] : []} onSelect={setHistoryDetail} />)}</div><CalendarLegend /></div><div className="history-list">{historyMonthLoading ? <><HistoryRowSkeleton /><HistoryRowSkeleton /><HistoryRowSkeleton /></> : historyMonthRecords.length === 0 ? <p className="drawer-note">No attendance recorded this month.</p> : historyMonthRecords.slice().reverse().map((entry) => <div className="history-row" key={`log-${entry.id}`}><div className="history-date"><strong>{entry.date.split(',')[0]}</strong><span>{entry.date.split(',').slice(1).join(',')}</span></div><div className="history-times"><strong>{entry.clockIn || '—'}</strong><span>{entry.clockOut ? `to ${entry.clockOut}` : 'Still working'}</span></div><span className="mode-tag">{entry.mode}</span><span className={`status-tag ${entry.status === 'On time' ? 'green' : entry.status === 'Excused (MC)' ? 'excused' : 'orange'}`}>{entry.status}</span></div>)}</div></article></section>}

        {activeTab === 'admin' && isAdmin && <section className="tab-panel admin-panel"><div className="tab-heading"><p className="eyebrow">ADMIN</p><h1>Attendance overview</h1><p>Every intern's attendance, and the office QR code.</p></div><article className="activity-card admin-qr-card"><div className="section-heading"><div><p className="eyebrow">OFFICE QR</p><h2>Current code</h2></div><div className="admin-qr-actions"><button className="secondary-action" onClick={downloadQr}><Download size={16} /> Save QR</button><button className="secondary-action" onClick={regenerateQr}><QrCode size={16} /> Regenerate</button></div></div>{qrDataUrl && <img src={qrDataUrl} alt="Office QR code" className="admin-qr-image" />}<p className="drawer-note">Regenerating invalidates the old code immediately -- update the printed or displayed copy at the office right away.</p></article><article className="activity-card"><div className="section-heading"><div><p className="eyebrow">ALL ATTENDANCE</p><h2>{adminMonthView ? formatMonthLabel(adminCalendarMonth) : adminDate}</h2></div><div className="admin-filter-bar"><button className={adminStatusFilter === 'Late' ? 'status-filter-button active-late' : 'status-filter-button'} onClick={() => setAdminStatusFilter((previous) => (previous === 'Late' ? null : 'Late'))}>Late</button><button className={adminStatusFilter === 'On time' ? 'status-filter-button active-ontime' : 'status-filter-button'} onClick={() => setAdminStatusFilter((previous) => (previous === 'On time' ? null : 'On time'))}>On time</button><input type="search" className="intern-select" list="admin-intern-options" placeholder="Search intern…" aria-label="Filter by intern" value={adminInternQuery} onChange={(event) => { const query = event.target.value; setAdminInternQuery(query); const picked = adminInterns.find((intern) => intern.name.toLowerCase() === query.trim().toLowerCase()); if (picked) setAdminFilterIntern(picked); else if (query.trim() === '') setAdminFilterIntern(null) }} /><datalist id="admin-intern-options">{adminInterns.map((intern) => <option key={intern.id} value={intern.name} />)}</datalist><a className="secondary-action export-button" href={adminExportUrl} download={adminExportFilename}><Download size={14} /> Export CSV</a></div></div><div className="admin-calendar"><div className="admin-calendar-header"><button className="icon-button" aria-label="Previous month" onClick={() => shiftAdminMonth(-1)}><ChevronLeft size={18} /></button><strong>{formatMonthLabel(adminCalendarMonth)}</strong><button className="icon-button" aria-label="Next month" onClick={() => shiftAdminMonth(1)}><ChevronRight size={18} /></button></div>{CALENDAR_WEEKDAYS}<div className="admin-calendar-grid">{adminCalendarWeeks.flat().map((date) => <CalendarDay key={date} date={date} month={adminCalendarMonth} isToday={date === todayDate} isSelected={date === adminDate} dimmed={Boolean(adminFilterIntern && adminStatusFilter && adminCalendarByDate[date] && adminCalendarByDate[date].status !== adminStatusFilter)} holidayName={adminHolidays[date]} chips={adminDayChips(adminCalendarByDate[date], adminFilterIntern, adminStatusFilter)} onSelect={setAdminDate} />)}</div><CalendarLegend /></div><div className="history-list">{(adminMonthView ? adminMonthLoading : adminLoading) ? <p className="drawer-note">Loading...</p> : visibleAdminRecords.length === 0 ? <p className="drawer-note">{adminMonthView ? `No${adminStatusFilter ? ` ${adminStatusFilter.toLowerCase()}` : ''} attendance${adminFilterIntern ? ` for ${adminFilterIntern.name}` : ''} this month.` : 'No attendance recorded for this date.'}</p> : visibleAdminRecords.map((record) => <div className="history-row" key={record.id}><div className="history-date"><button className="intern-name-button" onClick={() => toggleAdminFilterIntern(record)}>{record.internName}</button><span>{adminMonthView ? `${record.date} · ${record.refNumber}` : record.refNumber}</span></div><div className="history-times"><strong>{record.clockIn || '—'}</strong><span>{record.clockOut ? `to ${record.clockOut}` : 'Still working'}</span></div><span className="mode-tag">{record.mode}</span><span className={`status-tag ${record.status === 'On time' ? 'green' : record.status === 'Excused (MC)' ? 'excused' : 'orange'}`}>{record.status}</span></div>)}</div></article></section>}
      </main>
      <footer><span>Rizurf People Ops</span><span>Attendance service <b></b> All systems operational</span></footer>

      <nav className="bottom-nav" aria-label="Primary navigation"><button className={activeTab === 'home' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('home')}><Home size={21} /><span>Home</span></button><button className="nav-tab scan-tab" onClick={() => selectTab('scan')}><span className="scan-button"><ScanLine size={24} /></span><span>Scan</span></button><button className={activeTab === 'history' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('history')}><Clock3 size={21} /><span>History</span></button></nav>

      {historyDetail && <div className="modal-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && setHistoryDetail(null)}><div className="modal day-detail" role="dialog" aria-modal="true" aria-label="Day details"><button className="modal-close" aria-label="Close" onClick={() => setHistoryDetail(null)}><X size={18} /></button><h2>{Number(historyDetail.slice(8, 10))} <span>{new Date(`${historyDetail}T00:00:00`).toLocaleDateString([], { weekday: 'long' })}</span></h2>{historyHolidays[historyDetail] && <span className="cal-chip holiday">{historyHolidays[historyDetail]}</span>}{historyByDate[historyDetail] ? <div className="credential-list"><div><span>Clock in</span><strong>{historyByDate[historyDetail].clockIn || '—'}</strong></div><div><span>Clock out</span><strong>{historyByDate[historyDetail].clockOut || (historyDetail === todayDate ? 'Still working' : 'Not clocked out')}</strong></div><div><span>Mode</span><strong>{historyByDate[historyDetail].mode}</strong></div><div><span>Status</span><strong>{historyByDate[historyDetail].status}</strong></div></div> : <p className="drawer-note">No attendance recorded.</p>}</div></div>}
      {modal && <div className="modal-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && setModal(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="attendance-modal-title"><button className="modal-close" aria-label="Close" onClick={() => setModal(null)}><X size={18} /></button>{modal === 'mode' ? <><div className="modal-icon"><Clock3 size={22} /></div><p className="eyebrow">CLOCK {action.toUpperCase()}</p><h2 id="attendance-modal-title">How are you working today?</h2><p className="modal-subtitle">We will verify your attendance based on where you are.</p><div className="mode-options"><button className="mode-option" onClick={() => chooseMode('Office')}><span className="mode-icon office"><QrCode size={21} /></span><span><strong>At the office</strong><small>Scan QR and verify within 100m</small></span><ChevronRight size={17} /></button>{!(action === 'in' && scheduledMode === 'onsite') && <button className="mode-option" onClick={() => chooseMode('Hybrid')}><span className="mode-icon hybrid"><MapPin size={21} /></span><span><strong>Hybrid / away</strong><small>Clock {action} without office QR</small></span><ChevronRight size={17} /></button>}</div></> : <><div className="modal-icon"><QrCode size={22} /></div><p className="eyebrow">OFFICE QR VERIFICATION</p><h2 id="attendance-modal-title">Scan the office QR</h2><p className="modal-subtitle">Scan the QR code provided by Rizurf, then stay within 100m while location is checked.</p><div id="qr-reader" className="qr-reader"></div>{scanStatus && <p className="scanner-status">{scanStatus}</p>}{scannerError && <p className="scanner-error">{scannerError}</p>}<button className="text-button cancel-scan" onClick={() => setModal(null)}>Cancel scan</button></>}</div></div>}
      {profileOpen && <div className="profile-backdrop" onClick={(event) => event.target === event.currentTarget && setProfileOpen(false)}><aside className="profile-drawer"><button className="drawer-close" aria-label="Close profile" onClick={() => setProfileOpen(false)}><X size={19} /></button>{photoUrl ? <img src={photoUrl} alt="" className="drawer-avatar" onError={() => setAvatarFailed(true)} /> : <div className="drawer-avatar">{initials}</div>}<p className="eyebrow">INTERN PROFILE</p><h2>{displayName}</h2><div className="credential-list"><div><span>Department</span><strong>{intern?.department_name || '—'}</strong></div><div><span>Rizurf account</span><strong>{me?.email || '—'}</strong></div></div><div className="drawer-setting"><span><Bell size={18} /> Clock in/out reminder</span><button className={notificationsEnabled ? 'toggle is-on' : 'toggle'} aria-pressed={notificationsEnabled} onClick={toggleNotifications}><i></i></button></div>{isIos() && !isStandalone() ? <p className="drawer-note">On iPhone/iPad, reminders only work once this app is added to your Home Screen -- tap Share, then "Add to Home Screen", then open it from there.</p> : notificationsEnabled && !isIos() && <p className="drawer-note">Reminders keep arriving whether or not you're signed in here -- but some phones (Xiaomi, Huawei, Honor, Oppo, Samsung especially) pause background apps to save battery, which can silently stop them. If they ever stop coming through, check your phone's battery/app settings and allow this app to run in the background.</p>}<div className="drawer-setting"><span>{theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />} Dark mode</span><button className={theme === 'dark' ? 'toggle is-on' : 'toggle'} aria-pressed={theme === 'dark'} onClick={toggleTheme}><i></i></button></div>{isAdmin && <button className="drawer-setting drawer-action" onClick={() => { setProfileOpen(false); selectTab('admin') }}><ShieldCheck size={18} /> Admin<ChevronRight size={16} style={{ marginLeft: 'auto' }} /></button>}<p className="eyebrow drawer-section-label"><ShieldCheck size={14} /> LINKED DEVICES</p>{devices.length > 0 ? <div className="device-list">{devices.map((d) => <button key={d.id} className="device-row" onClick={() => unlinkDevice(d.id)}><span className="device-icon"><Smartphone size={17} /></span><span className="device-info"><strong>{d.label}{d.isCurrent && <span className="device-current-tag"> · This device</span>}</strong><small>Last active {d.lastUsedAt}</small></span><X size={15} /></button>)}</div> : <p className="drawer-note">No devices linked yet. The first time you clock in, this device links to you -- after that, no one else can clock in from it.</p>}</aside></div>}
    </div>
  )
}

export default App
