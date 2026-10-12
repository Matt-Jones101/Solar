import {
  ArcType,
  buildModuleUrl,
  Cartesian3,
  ClockRange,
  Color,
  ConstantPositionProperty,
  ConstantProperty,
  CubeMapPanorama,
  HeadingPitchRange,
  JulianDate,
  Matrix3,
  Viewer,
} from 'cesium'

import 'cesium/Build/Cesium/Widgets/widgets.css'
import './style.css'


// --------------------------------------------------
// CREATE VIEWER
// --------------------------------------------------

const viewer = new Viewer('cesiumContainer')

// Allow Solar-System-scale viewing distances.
viewer.camera.frustum.far = 100_000_000_000_000

type SolarCameraController =
  typeof viewer.scene.screenSpaceCameraController & {
    _maximumZoomRate?: number
  }

const cameraController =
  viewer.scene.screenSpaceCameraController as SolarCameraController


// --------------------------------------------------
// REMOVE EARTH-SPECIFIC CESIUM FEATURES
// --------------------------------------------------

viewer.scene.globe.show = false
if (viewer.scene.skyAtmosphere) {
  viewer.scene.skyAtmosphere.show = false
}
viewer.scene.fog.enabled = false
if (viewer.scene.sun) {
  viewer.scene.sun.show = false
}
if (viewer.scene.moon) {
  viewer.scene.moon.show = false
}
if (viewer.scene.skyBox) {
  viewer.scene.skyBox.show = false
}
cameraController.enableCollisionDetection = false

// Cesium's default maximum zoom rate is roughly the
// Sun-Pluto distance. That is sensible for Earth scenes,
// but it feels artificially slow when viewing the whole
// Solar System from far outside Neptune and Pluto.
cameraController._maximumZoomRate = 100_000_000_000_000


// --------------------------------------------------
// TIME
// --------------------------------------------------

const now = JulianDate.now()

viewer.clock.currentTime = JulianDate.clone(now)

// Start paused.
viewer.clock.shouldAnimate = false

// When playing:
// 1 real second = 1 simulated day.
viewer.clock.multiplier = 86_400

viewer.clock.clockRange = ClockRange.UNBOUNDED

const timelineStart = JulianDate.addDays(now, -365, new JulianDate())
const timelineEnd = JulianDate.addDays(now, 365, new JulianDate())

viewer.clock.startTime = JulianDate.clone(timelineStart)
viewer.clock.stopTime = JulianDate.clone(timelineEnd)


// --------------------------------------------------
// TIMELINE
// --------------------------------------------------

type TimelineTickUnit =
  | 'year'
  | 'month'
  | 'day'
  | 'hour'
  | 'minute'
  | 'second'

type TimelineTickLevel = {
  unit: TimelineTickUnit
  step: number
  approxSeconds: number
}

type TimelineRenderState = {
  startTime: number
  startJulian: JulianDate
  epochJulian: JulianDate
  duration: number
  timeBarWidth: number
  getAlpha: (time: number) => number
  y?: number
}

type TimelineInternals = {
  _context: CanvasRenderingContext2D
  _endJulian: JulianDate
  _epochJulian?: JulianDate
  _highlightRanges: Array<{
    render: (renderState: TimelineRenderState) => string
  }>
  _lastXPos?: number
  _mainTicSpan: number
  _makeTics: () => void
  _needleEle: HTMLElement
  _rulerEle: HTMLElement
  _scrubElement?: ChildNode | null
  _scrubJulian: JulianDate
  _solarTimelineLevel?: TimelineTickLevel
  _startJulian: JulianDate
  _timeBarEle: HTMLElement
  _timeBarSecondsSpan: number
  _topDiv: HTMLElement
  _trackList: Array<{
    height: number
    render: (
      context: CanvasRenderingContext2D,
      renderState: TimelineRenderState
    ) => void
  }>
  _trackListEle: HTMLCanvasElement
  makeLabel: (time: JulianDate) => string
  smallestTicInPixels: number
  zoomTo: (
    start: JulianDate,
    end: JulianDate
  ) => void
}

// Closest allowed timeline zoom:
// 1 hour.
const TIMELINE_MIN_SPAN_SECONDS = 60 * 60

// Furthest allowed timeline zoom:
// 1000 years.
const TIMELINE_MAX_SPAN_SECONDS = 1000 * 365 * 86_400

const TIMELINE_MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR
const SECONDS_PER_YEAR = 365.2425 * SECONDS_PER_DAY

const TIMELINE_TICK_LEVELS: TimelineTickLevel[] = [
  { unit: 'second', step: 1, approxSeconds: 1 },
  { unit: 'second', step: 5, approxSeconds: 5 },
  { unit: 'second', step: 15, approxSeconds: 15 },
  { unit: 'second', step: 30, approxSeconds: 30 },
  { unit: 'minute', step: 1, approxSeconds: SECONDS_PER_MINUTE },
  { unit: 'minute', step: 5, approxSeconds: 5 * SECONDS_PER_MINUTE },
  { unit: 'minute', step: 10, approxSeconds: 10 * SECONDS_PER_MINUTE },
  { unit: 'minute', step: 15, approxSeconds: 15 * SECONDS_PER_MINUTE },
  { unit: 'minute', step: 30, approxSeconds: 30 * SECONDS_PER_MINUTE },
  { unit: 'hour', step: 1, approxSeconds: SECONDS_PER_HOUR },
  { unit: 'hour', step: 2, approxSeconds: 2 * SECONDS_PER_HOUR },
  { unit: 'hour', step: 3, approxSeconds: 3 * SECONDS_PER_HOUR },
  { unit: 'hour', step: 6, approxSeconds: 6 * SECONDS_PER_HOUR },
  { unit: 'hour', step: 12, approxSeconds: 12 * SECONDS_PER_HOUR },
  { unit: 'day', step: 1, approxSeconds: SECONDS_PER_DAY },
  { unit: 'day', step: 2, approxSeconds: 2 * SECONDS_PER_DAY },
  { unit: 'day', step: 4, approxSeconds: 4 * SECONDS_PER_DAY },
  { unit: 'day', step: 7, approxSeconds: 7 * SECONDS_PER_DAY },
  { unit: 'day', step: 15, approxSeconds: 15 * SECONDS_PER_DAY },
  { unit: 'month', step: 1, approxSeconds: SECONDS_PER_YEAR / 12 },
  { unit: 'month', step: 2, approxSeconds: SECONDS_PER_YEAR / 6 },
  { unit: 'month', step: 3, approxSeconds: SECONDS_PER_YEAR / 4 },
  { unit: 'month', step: 6, approxSeconds: SECONDS_PER_YEAR / 2 },
  { unit: 'year', step: 1, approxSeconds: SECONDS_PER_YEAR },
  { unit: 'year', step: 2, approxSeconds: 2 * SECONDS_PER_YEAR },
  { unit: 'year', step: 5, approxSeconds: 5 * SECONDS_PER_YEAR },
  { unit: 'year', step: 10, approxSeconds: 10 * SECONDS_PER_YEAR },
  { unit: 'year', step: 25, approxSeconds: 25 * SECONDS_PER_YEAR },
  { unit: 'year', step: 50, approxSeconds: 50 * SECONDS_PER_YEAR },
  { unit: 'year', step: 100, approxSeconds: 100 * SECONDS_PER_YEAR },
]

function installTimelineTickLadder(
  timeline: TimelineInternals
) {
  timeline.makeLabel = (
    time: JulianDate
  ): string => {
    return formatTimelineLabel(
      time,
      timeline._solarTimelineLevel ?? TIMELINE_TICK_LEVELS[14]
    )
  }

  timeline._makeTics = function makeDeterministicTimelineTicks() {
    const duration =
      this._timeBarSecondsSpan

    const timeBar =
      this._timeBarEle

    const timeBarWidth =
      Math.max(
        timeBar.clientWidth,
        10
      )

    const scrubSeconds =
      JulianDate.secondsDifference(
        this._scrubJulian,
        this._startJulian
      )

    const scrubX =
      Math.round(
        (
          scrubSeconds *
          this._topDiv.clientWidth
        ) /
        duration
      )

    const mainLevel =
      chooseTimelineLevel(
        this,
        duration,
        timeBarWidth
      )

    const mainLevelIndex =
      TIMELINE_TICK_LEVELS.indexOf(
        mainLevel
      )

    const subLevel =
      chooseSubTickLevel(
        mainLevel,
        mainLevelIndex,
        duration,
        timeBarWidth,
        12
      )

    const tinyLevel =
      subLevel
        ? chooseSubTickLevel(
          subLevel.level,
          subLevel.index,
          duration,
          timeBarWidth,
          this.smallestTicInPixels
        )
        : undefined

    const mainTickPositions =
      collectTimelineTickPositions(
        this,
        mainLevel
      )

    const subTickPositions =
      subLevel
        ? collectTimelineTickPositions(
          this,
          subLevel.level
        )
        : new Set<number>()

    this._solarTimelineLevel =
      mainLevel

    this._mainTicSpan =
      mainLevel.approxSeconds

    this._needleEle.style.left =
      `${scrubX.toString()}px`

    const epochJulian =
      floorTimelineTick(
        this._startJulian,
        mainLevel
      )

    const startTime =
      JulianDate.secondsDifference(
        this._startJulian,
        epochJulian
      )

    const renderState: TimelineRenderState = {
      startTime,
      startJulian: this._startJulian,
      epochJulian,
      duration,
      timeBarWidth,
      getAlpha: (time: number) =>
        (
          time -
          startTime
        ) /
        duration,
    }

    this._epochJulian =
      epochJulian

    let tics = ''

    this._highlightRanges.forEach(
      (
        highlightRange
      ) => {
        tics +=
          highlightRange.render(
            renderState
          )
      }
    )

    if (tinyLevel) {
      tics +=
        renderTimelineUnlabelledTicks(
          this,
          tinyLevel.level,
          'cesium-timeline-ticTiny',
          [
            mainTickPositions,
            subTickPositions,
          ]
        )
    }

    if (subLevel) {
      tics +=
        renderTimelineUnlabelledTicks(
          this,
          subLevel.level,
          'cesium-timeline-ticSub',
          [
            mainTickPositions,
          ]
        )
    }

    tics +=
      renderTimelineMainTicks(
        this,
        mainLevel
      )

    tics +=
      `<span class="cesium-timeline-icon16" style="left:${(scrubX - 8).toString()}px;bottom:0;background-position: 0 0;"></span>`

    timeBar.innerHTML =
      tics

    this._scrubElement =
      timeBar.lastChild

    this._context.clearRect(
      0,
      0,
      this._trackListEle.width,
      this._trackListEle.height
    )

    renderState.y = 0

    this._trackList.forEach(
      (
        track
      ) => {
        track.render(
          this._context,
          renderState
        )

        renderState.y =
          (
            renderState.y ?? 0
          ) +
          track.height
      }
    )
  }
}

function collectTimelineTickPositions(
  timeline: TimelineInternals,
  level: TimelineTickLevel
): Set<number> {
  const positions =
    new Set<number>()

  const timeBarWidth =
    Math.max(
      timeline._timeBarEle.clientWidth,
      10
    )

  const endLimit =
    JulianDate.addSeconds(
      timeline._endJulian,
      level.approxSeconds * 1.5,
      new JulianDate()
    )

  forEachTimelineTick(
    timeline._startJulian,
    endLimit,
    level,
    (
      tickTime
    ) => {
      const left =
        getTimelineTickLeft(
          timeline,
          tickTime,
          timeBarWidth
        )

      if (
        left >= -1 &&
        left <= timeBarWidth + 1
      ) {
        positions.add(
          left
        )
      }
    }
  )

  return positions
}

function chooseTimelineLevel(
  timeline: TimelineInternals,
  duration: number,
  timeBarWidth: number
): TimelineTickLevel {
  for (const level of TIMELINE_TICK_LEVELS) {
    timeline._rulerEle.textContent =
      formatTimelineLabel(
        timeline._endJulian,
        level
      )

    const labelWidth =
      Math.max(
        30,
        timeline._rulerEle.offsetWidth + 24
      )

    const spacing =
      timeBarWidth *
      (
        level.approxSeconds /
        duration
      )

    if (spacing >= labelWidth) {
      return level
    }
  }

  return TIMELINE_TICK_LEVELS[
    TIMELINE_TICK_LEVELS.length - 1
  ]
}

function chooseSubTickLevel(
  parent: TimelineTickLevel,
  parentIndex: number,
  duration: number,
  timeBarWidth: number,
  minimumPixels: number
):
  | {
    level: TimelineTickLevel
    index: number
  }
  | undefined {
  for (
    let index = parentIndex - 1;
    index >= 0;
    index--
  ) {
    const candidate =
      TIMELINE_TICK_LEVELS[index]

    const spacing =
      timeBarWidth *
      (
        candidate.approxSeconds /
        duration
      )

    if (
      spacing >= minimumPixels &&
      canSubdivideTimelineLevel(
        parent,
        candidate
      )
    ) {
      return {
        level: candidate,
        index,
      }
    }
  }

  return undefined
}

function canSubdivideTimelineLevel(
  parent: TimelineTickLevel,
  child: TimelineTickLevel
): boolean {
  if (parent.unit === 'year') {
    if (child.unit === 'year') {
      return parent.step % child.step === 0
    }

    return (
      child.unit === 'month' &&
      (
        parent.step * 12
      ) %
      child.step === 0
    )
  }

  if (parent.unit === 'month') {
    if (child.unit === 'month') {
      return parent.step % child.step === 0
    }

    return false
  }

  const parentSeconds =
    fixedTimelineSeconds(
      parent
    )

  const childSeconds =
    fixedTimelineSeconds(
      child
    )

  return (
    parentSeconds !== undefined &&
    childSeconds !== undefined &&
    parentSeconds % childSeconds === 0
  )
}

function fixedTimelineSeconds(
  level: TimelineTickLevel
): number | undefined {
  if (level.unit === 'day') {
    return level.step * SECONDS_PER_DAY
  }

  if (level.unit === 'hour') {
    return level.step * SECONDS_PER_HOUR
  }

  if (level.unit === 'minute') {
    return level.step * SECONDS_PER_MINUTE
  }

  if (level.unit === 'second') {
    return level.step
  }

  return undefined
}

function renderTimelineUnlabelledTicks(
  timeline: TimelineInternals,
  level: TimelineTickLevel,
  className: string,
  occupiedPositions: Array<Set<number>> = []
): string {
  let tics = ''

  const ownPositions =
    new Set<number>()

  const timeBarWidth =
    Math.max(
      timeline._timeBarEle.clientWidth,
      10
    )

  const endLimit =
    JulianDate.addSeconds(
      timeline._endJulian,
      level.approxSeconds * 1.5,
      new JulianDate()
    )

  forEachTimelineTick(
    timeline._startJulian,
    endLimit,
    level,
    (
      tickTime
    ) => {
      const left =
        getTimelineTickLeft(
          timeline,
          tickTime,
          timeBarWidth
        )

      if (
        left >= -1 &&
        left <= timeBarWidth + 1 &&
        !hasNearbyTimelineTick(
          left,
          [
            ownPositions,
            ...occupiedPositions,
          ]
        )
      ) {
        ownPositions.add(
          left
        )

        tics +=
          `<span class="${className}" style="left: ${left.toString()}px;"></span>`
      }
    }
  )

  return tics
}

function renderTimelineMainTicks(
  timeline: TimelineInternals,
  level: TimelineTickLevel
): string {
  let tics = ''

  let lastTextLeft =
    -999999

  const shownLabels =
    new Set<string>()

  const timeBarWidth =
    Math.max(
      timeline._timeBarEle.clientWidth,
      10
    )

  const endLimit =
    JulianDate.addSeconds(
      timeline._endJulian,
      level.approxSeconds * 1.5,
      new JulianDate()
    )

  forEachTimelineTick(
    timeline._startJulian,
    endLimit,
    level,
    (
      tickTime
    ) => {
      const left =
        getTimelineTickLeft(
          timeline,
          tickTime,
          timeBarWidth
        )

      if (
        left < -1 ||
        left > timeBarWidth + 1
      ) {
        return
      }

      const label =
        formatTimelineLabel(
          tickTime,
          level
        )

      timeline._rulerEle.textContent =
        label

      const textWidth =
        Math.max(
          10,
          timeline._rulerEle.offsetWidth
        )

      const labelLeft =
        left -
        (
          textWidth / 2 -
          1
        )

      const labelIsVisible =
        labelLeft + textWidth > 0 &&
        labelLeft < timeBarWidth

      if (
        labelIsVisible &&
        labelLeft > lastTextLeft &&
        !shownLabels.has(
          label
        )
      ) {
        lastTextLeft =
          labelLeft +
          textWidth +
          5

        shownLabels.add(
          label
        )

        tics +=
          `<span class="cesium-timeline-ticMain" style="left: ${left.toString()}px;"></span>` +
          `<span class="cesium-timeline-ticLabel" style="left: ${labelLeft.toString()}px;">${label}</span>`
      } else {
        tics +=
          `<span class="cesium-timeline-ticSub" style="left: ${left.toString()}px;"></span>`
      }
    }
  )

  return tics
}

function getTimelineTickLeft(
  timeline: TimelineInternals,
  tickTime: JulianDate,
  timeBarWidth: number
): number {
  const tickSeconds =
    JulianDate.secondsDifference(
      tickTime,
      timeline._startJulian
    )

  return Math.round(
    timeBarWidth *
    (
      tickSeconds /
      timeline._timeBarSecondsSpan
    )
  )
}

function hasNearbyTimelineTick(
  left: number,
  positionSets: Array<Set<number>>
): boolean {
  return positionSets.some(
    (
      positions
    ) =>
      positions.has(
        left
      ) ||
      positions.has(
        left - 1
      ) ||
      positions.has(
        left + 1
      )
  )
}

function forEachTimelineTick(
  start: JulianDate,
  end: JulianDate,
  level: TimelineTickLevel,
  callback: (
    tickTime: JulianDate
  ) => void
) {
  let tickTime =
    floorTimelineTick(
      start,
      level
    )

  let guard = 0

  while (
    JulianDate.lessThanOrEquals(
      tickTime,
      end
    ) &&
    guard < 20000
  ) {
    callback(
      tickTime
    )

    tickTime =
      addTimelineLevel(
        tickTime,
        level
      )

    guard++
  }
}

function floorTimelineTick(
  time: JulianDate,
  level: TimelineTickLevel
): JulianDate {
  const date =
    JulianDate.toDate(
      time
    )

  const year =
    date.getUTCFullYear()

  const month =
    date.getUTCMonth()

  if (level.unit === 'year') {
    return julianFromUtcParts(
      Math.floor(
        year / level.step
      ) *
      level.step
    )
  }

  if (level.unit === 'month') {
    const monthIndex =
      year * 12 +
      month

    const flooredMonthIndex =
      Math.floor(
        monthIndex / level.step
      ) *
      level.step

    const flooredYear =
      Math.floor(
        flooredMonthIndex / 12
      )

    const flooredMonth =
      flooredMonthIndex -
      flooredYear * 12

    return julianFromUtcParts(
      flooredYear,
      flooredMonth
    )
  }

  const intervalMs =
    (
      fixedTimelineSeconds(
        level
      ) ??
      level.approxSeconds
    ) *
    1000

  const mondayEpochMs =
    Date.UTC(
      1970,
      0,
      5
    )

  const baseMs =
    level.unit === 'day' &&
    level.step === 7
      ? mondayEpochMs
      : 0

  const flooredMs =
    Math.floor(
      (
        date.getTime() -
        baseMs
      ) /
      intervalMs
    ) *
    intervalMs +
    baseMs

  return JulianDate.fromDate(
    new Date(
      flooredMs
    )
  )
}

function addTimelineLevel(
  time: JulianDate,
  level: TimelineTickLevel
): JulianDate {
  const date =
    JulianDate.toDate(
      time
    )

  if (level.unit === 'year') {
    date.setUTCFullYear(
      date.getUTCFullYear() +
      level.step
    )
  } else if (level.unit === 'month') {
    date.setUTCMonth(
      date.getUTCMonth() +
      level.step
    )
  } else {
    date.setTime(
      date.getTime() +
      (
        fixedTimelineSeconds(
          level
        ) ??
        level.approxSeconds
      ) *
      1000
    )
  }

  return JulianDate.fromDate(
    date
  )
}

function julianFromUtcParts(
  year: number,
  month = 0,
  day = 1,
  hour = 0,
  minute = 0,
  second = 0
): JulianDate {
  const date =
    new Date(
      0
    )

  date.setUTCFullYear(
    year,
    month,
    day
  )

  date.setUTCHours(
    hour,
    minute,
    second,
    0
  )

  return JulianDate.fromDate(
    date
  )
}

function formatTimelineLabel(
  time: JulianDate,
  level: TimelineTickLevel
): string {
  const date =
    JulianDate.toDate(
      time
    )

  const year =
    date.getUTCFullYear().toString()

  const month =
    TIMELINE_MONTH_NAMES[
      date.getUTCMonth()
    ]

  const day =
    twoDigit(
      date.getUTCDate()
    )

  const hour =
    twoDigit(
      date.getUTCHours()
    )

  const minute =
    twoDigit(
      date.getUTCMinutes()
    )

  const second =
    twoDigit(
      date.getUTCSeconds()
    )

  if (level.unit === 'year') {
    return year
  }

  if (level.unit === 'month') {
    return `${month} ${year}`
  }

  if (level.unit === 'day') {
    return `${day} ${month} ${year}`
  }

  if (
    level.unit === 'hour' ||
    level.unit === 'minute'
  ) {
    return `${day} ${month} ${year} ${hour}:${minute} UTC`
  }

  return `${day} ${month} ${year} ${hour}:${minute}:${second} UTC`
}

function twoDigit(
  value: number
): string {
  return value
    .toString()
    .padStart(
      2,
      '0'
    )
}

if (viewer.timeline) {
  const timeline =
    viewer.timeline as unknown as TimelineInternals

  installTimelineTickLadder(
    timeline
  )

  const originalZoomTo =
    timeline.zoomTo.bind(
      timeline
    )

  timeline.zoomTo = (requestedStart: JulianDate, requestedEnd: JulianDate) => {
    const requestedSpan = JulianDate.secondsDifference(
      requestedEnd,
      requestedStart
    )

    let clampedSpan = requestedSpan

    if (clampedSpan < TIMELINE_MIN_SPAN_SECONDS) {
      clampedSpan = TIMELINE_MIN_SPAN_SECONDS
    }

    if (clampedSpan > TIMELINE_MAX_SPAN_SECONDS) {
      clampedSpan = TIMELINE_MAX_SPAN_SECONDS
    }


    // Requested zoom is already valid.
    if (clampedSpan === requestedSpan) {
      originalZoomTo(requestedStart, requestedEnd)
      return
    }


    // Keep the zoom centred around the same point.
    const centre = JulianDate.addSeconds(
      requestedStart,
      requestedSpan / 2,
      new JulianDate()
    )

    const clampedStart = JulianDate.addSeconds(
      centre,
      -clampedSpan / 2,
      new JulianDate()
    )

    const clampedEnd = JulianDate.addSeconds(
      centre,
      clampedSpan / 2,
      new JulianDate()
    )

    originalZoomTo(clampedStart, clampedEnd)
  }


  // Force Cesium to rebuild its ticks after replacing
  // the tick builder and label formatter.
  timeline.zoomTo(timelineStart, timelineEnd)
}


// --------------------------------------------------
// CONSTANTS
// --------------------------------------------------

// One Astronomical Unit:
// approximately the mean Earth-Sun distance.
const AU = 149_597_870_700

// Sun radius in metres.
const sun_rad = 696_340_000

// Heliocentric system:
// Sun is at the origin.
const sun_pos = Cartesian3.ZERO

// J2000 obliquity.
//
// Obliquity is the angle between Earth's equatorial
// plane and the ecliptic reference plane.
const J2000_OBLIQUITY = 23.43928 * Math.PI / 180


// --------------------------------------------------
// FIXED J2000 STAR BACKGROUND
// --------------------------------------------------

const skyBoxBaseUrl = buildModuleUrl(
  'Assets/Textures/SkyBox/tycho2t3_80'
)

const starFieldTransform = Matrix3.fromRotationX(
  -J2000_OBLIQUITY
)

viewer.scene.primitives.add(
  new CubeMapPanorama({
    sources: {
      positiveX: `${skyBoxBaseUrl}_px.jpg`,
      negativeX: `${skyBoxBaseUrl}_mx.jpg`,
      positiveY: `${skyBoxBaseUrl}_py.jpg`,
      negativeY: `${skyBoxBaseUrl}_my.jpg`,
      positiveZ: `${skyBoxBaseUrl}_pz.jpg`,
      negativeZ: `${skyBoxBaseUrl}_mz.jpg`,
    },

    transform: starFieldTransform,
  })
)


// --------------------------------------------------
// TYPES
// --------------------------------------------------

type OrbitalValue = {
  base: number
  rate: number
}

type PlanetData = {
  name: string
  radius: number
  colour: string

  a: OrbitalValue
  e: OrbitalValue
  i: OrbitalValue
  L: OrbitalValue

  longitudePerihelion: OrbitalValue
  longitudeAscendingNode: OrbitalValue
}

type BillboardState = {
  alpha: number
  visible: boolean
}

type PlanetRenderData = {
  planet: PlanetData
  positionProperty: ConstantPositionProperty
  billboardColor: ConstantProperty
  billboardState: BillboardState
  orbitPositions: ConstantProperty
}


// --------------------------------------------------
// PLANET DATA
// --------------------------------------------------

const planets: PlanetData[] = [
  {
    name: 'Mercury',
    radius: 2_439_700,
    colour: '#9b9b9b',

    a: { base: 0.38709927, rate: 0.00000037 },
    e: { base: 0.20563593, rate: 0.00001906 },
    i: { base: 7.00497902, rate: -0.00594749 },
    L: { base: 252.25032350, rate: 149472.67411175 },

    longitudePerihelion: {
      base: 77.45779628,
      rate: 0.16047689,
    },

    longitudeAscendingNode: {
      base: 48.33076593,
      rate: -0.12534081,
    },
  },

  {
    name: 'Venus',
    radius: 6_051_800,
    colour: '#d7a85c',

    a: { base: 0.72333566, rate: 0.00000390 },
    e: { base: 0.00677672, rate: -0.00004107 },
    i: { base: 3.39467605, rate: -0.00078890 },
    L: { base: 181.97909950, rate: 58517.81538729 },

    longitudePerihelion: {
      base: 131.60246718,
      rate: 0.00268329,
    },

    longitudeAscendingNode: {
      base: 76.67984255,
      rate: -0.27769418,
    },
  },

  {
    name: 'Earth',
    radius: 6_371_000,
    colour: '#3d7fff',

    a: { base: 1.00000261, rate: 0.00000562 },
    e: { base: 0.01671123, rate: -0.00004392 },
    i: { base: -0.00001531, rate: -0.01294668 },
    L: { base: 100.46457166, rate: 35999.37244981 },

    longitudePerihelion: {
      base: 102.93768193,
      rate: 0.32327364,
    },

    longitudeAscendingNode: {
      base: 0,
      rate: 0,
    },
  },

  {
    name: 'Mars',
    radius: 3_389_500,
    colour: '#c85c3b',

    a: { base: 1.52371034, rate: 0.00001847 },
    e: { base: 0.09339410, rate: 0.00007882 },
    i: { base: 1.84969142, rate: -0.00813131 },
    L: { base: -4.55343205, rate: 19140.30268499 },

    longitudePerihelion: {
      base: -23.94362959,
      rate: 0.44441088,
    },

    longitudeAscendingNode: {
      base: 49.55953891,
      rate: -0.29257343,
    },
  },

  {
    name: 'Jupiter',
    radius: 69_911_000,
    colour: '#d0ad83',

    a: { base: 5.20288700, rate: -0.00011607 },
    e: { base: 0.04838624, rate: -0.00013253 },
    i: { base: 1.30439695, rate: -0.00183714 },
    L: { base: 34.39644051, rate: 3034.74612775 },

    longitudePerihelion: {
      base: 14.72847983,
      rate: 0.21252668,
    },

    longitudeAscendingNode: {
      base: 100.47390909,
      rate: 0.20469106,
    },
  },

  {
    name: 'Saturn',
    radius: 58_232_000,
    colour: '#decf91',

    a: { base: 9.53667594, rate: -0.00125060 },
    e: { base: 0.05386179, rate: -0.00050991 },
    i: { base: 2.48599187, rate: 0.00193609 },
    L: { base: 49.95424423, rate: 1222.49362201 },

    longitudePerihelion: {
      base: 92.59887831,
      rate: -0.41897216,
    },

    longitudeAscendingNode: {
      base: 113.66242448,
      rate: -0.28867794,
    },
  },

  {
    name: 'Uranus',
    radius: 25_362_000,
    colour: '#7bd5df',

    a: { base: 19.18916464, rate: -0.00196176 },
    e: { base: 0.04725744, rate: -0.00004397 },
    i: { base: 0.77263783, rate: -0.00242939 },
    L: { base: 313.23810451, rate: 428.48202785 },

    longitudePerihelion: {
      base: 170.95427630,
      rate: 0.40805281,
    },

    longitudeAscendingNode: {
      base: 74.01692503,
      rate: 0.04240589,
    },
  },

  {
    name: 'Neptune',
    radius: 24_622_000,
    colour: '#4266db',

    a: { base: 30.06992276, rate: 0.00026291 },
    e: { base: 0.00859048, rate: 0.00005105 },
    i: { base: 1.77004347, rate: 0.00035372 },
    L: { base: -55.12002969, rate: 218.45945325 },

    longitudePerihelion: {
      base: 44.96476227,
      rate: -0.32241464,
    },

    longitudeAscendingNode: {
      base: 131.78422574,
      rate: -0.00508664,
    },
  },

  {
    name: 'Pluto',
    radius: 1_188_300,
    colour: '#a8947a',

    a: { base: 39.48211675, rate: -0.00031596 },
    e: { base: 0.24882730, rate: 0.00005170 },
    i: { base: 17.14001206, rate: 0.00004818 },
    L: { base: 238.92903833, rate: 145.20780515 },

    longitudePerihelion: {
      base: 224.06891629,
      rate: -0.04062942,
    },

    longitudeAscendingNode: {
      base: 110.30393684,
      rate: -0.01183482,
    },
  },
]


// --------------------------------------------------
// BASIC MATH
// --------------------------------------------------

function degToRad(degrees: number): number {
  return degrees * Math.PI / 180
}

function normaliseRadians(angle: number): number {
  angle %= Math.PI * 2

  if (angle > Math.PI) angle -= Math.PI * 2
  if (angle < -Math.PI) angle += Math.PI * 2

  return angle
}


// --------------------------------------------------
// JULIAN TIME
// --------------------------------------------------

function getJulianDay(time: JulianDate): number {
  const date = JulianDate.toDate(time)

  return date.getTime() / 86_400_000 + 2_440_587.5
}

function getJulianCenturies(time: JulianDate): number {
  return (getJulianDay(time) - 2_451_545.0) / 36_525
}


// --------------------------------------------------
// ORBITAL ELEMENTS AT A GIVEN TIME
// --------------------------------------------------

function orbitalValueAtTime(
  value: OrbitalValue,
  centuries: number
): number {
  return value.base + value.rate * centuries
}

function getOrbitalElements(
  planet: PlanetData,
  time: JulianDate
) {
  const T = getJulianCenturies(time)

  return {
    a: orbitalValueAtTime(planet.a, T) * AU,

    e:
      orbitalValueAtTime(
        planet.e,
        T
      ),

    i:
      degToRad(
        orbitalValueAtTime(
          planet.i,
          T
        )
      ),

    L:
      degToRad(
        orbitalValueAtTime(
          planet.L,
          T
        )
      ),

    longitudePerihelion:
      degToRad(
        orbitalValueAtTime(
          planet.longitudePerihelion,
          T
        )
      ),

    longitudeAscendingNode:
      degToRad(
        orbitalValueAtTime(
          planet.longitudeAscendingNode,
          T
        )
      ),
  }
}


// --------------------------------------------------
// SOLVE KEPLER'S EQUATION
// --------------------------------------------------

function solveEccentricAnomaly(
  meanAnomaly: number,
  eccentricity: number
): number {
  const M = normaliseRadians(meanAnomaly)

  let E = M

  for (let i = 0; i < 10; i++) {
    const error =
      E -
      eccentricity * Math.sin(E) -
      M

    const slope =
      1 -
      eccentricity * Math.cos(E)

    E -= error / slope
  }

  return E
}


// --------------------------------------------------
// ROTATE ORBIT INTO 3D SPACE
// --------------------------------------------------

function orbitalPlaneToWorld(
  xPrime: number,
  yPrime: number,
  inclination: number,
  longitudeAscendingNode: number,
  argumentPerihelion: number
): Cartesian3 {
  const cosW = Math.cos(argumentPerihelion)
  const sinW = Math.sin(argumentPerihelion)

  const cosO = Math.cos(longitudeAscendingNode)
  const sinO = Math.sin(longitudeAscendingNode)

  const cosI = Math.cos(inclination)
  const sinI = Math.sin(inclination)

  const x =
    (cosW * cosO - sinW * sinO * cosI) * xPrime +
    (-sinW * cosO - cosW * sinO * cosI) * yPrime

  const y =
    (cosW * sinO + sinW * cosO * cosI) * xPrime +
    (-sinW * sinO + cosW * cosO * cosI) * yPrime

  const z =
    (sinW * sinI) * xPrime +
    (cosW * sinI) * yPrime

  return new Cartesian3(x, y, z)
}


// --------------------------------------------------
// CALCULATE PLANET POSITION
// --------------------------------------------------

function getPlanetPosition(
  planet: PlanetData,
  time: JulianDate
): Cartesian3 {
  const elements = getOrbitalElements(
    planet,
    time
  )

  const argumentPerihelion =
    elements.longitudePerihelion -
    elements.longitudeAscendingNode

  const meanAnomaly =
    elements.L -
    elements.longitudePerihelion

  const eccentricAnomaly =
    solveEccentricAnomaly(
      meanAnomaly,
      elements.e
    )

  const xPrime =
    elements.a *
    (
      Math.cos(eccentricAnomaly) -
      elements.e
    )

  const yPrime =
    elements.a *
    Math.sqrt(
      1 -
      elements.e * elements.e
    ) *
    Math.sin(eccentricAnomaly)

  return orbitalPlaneToWorld(
    xPrime,
    yPrime,
    elements.i,
    elements.longitudeAscendingNode,
    argumentPerihelion
  )
}


// --------------------------------------------------
// CREATE ORBIT ELLIPSE
// --------------------------------------------------

function createOrbitPositions(
  planet: PlanetData,
  time: JulianDate,
  segments: number = 720
): Cartesian3[] {
  const elements = getOrbitalElements(
    planet,
    time
  )

  const argumentPerihelion =
    elements.longitudePerihelion -
    elements.longitudeAscendingNode

  const positions: Cartesian3[] = []

  for (let i = 0; i <= segments; i++) {
    const eccentricAnomaly =
      (i / segments) *
      Math.PI * 2

    const xPrime =
      elements.a *
      (
        Math.cos(eccentricAnomaly) -
        elements.e
      )

    const yPrime =
      elements.a *
      Math.sqrt(
        1 -
        elements.e * elements.e
      ) *
      Math.sin(eccentricAnomaly)

    positions.push(
      orbitalPlaneToWorld(
        xPrime,
        yPrime,
        elements.i,
        elements.longitudeAscendingNode,
        argumentPerihelion
      )
    )
  }

  return positions
}


// --------------------------------------------------
// BILLBOARD ICON
// --------------------------------------------------

function makeCircleIcon(
  colour: string
): string {
  const svg = `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="64"
      height="64"
      viewBox="0 0 64 64"
    >
      <circle
        cx="32"
        cy="32"
        r="28"
        fill="${colour}"
      />
    </svg>
  `

  return (
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(svg)
  )
}


// --------------------------------------------------
// SUN
// --------------------------------------------------

const sunBillboardColor =
  new ConstantProperty(
    Color.WHITE
  )

const sunBillboardState: BillboardState = {
  alpha: 1,
  visible: true,
}

viewer.entities.add({
  name: 'Sun',

  position: sun_pos,

  ellipsoid: {
    radii:
      new Cartesian3(
        sun_rad,
        sun_rad,
        sun_rad
      ),

    material:
      Color.fromCssColorString(
        '#ffb300'
      ),
  },

  billboard: {
    image:
      makeCircleIcon(
        '#ffcc33'
      ),

    width: 32,
    height: 32,

    color:
      sunBillboardColor,

    disableDepthTestDistance:
      Number.POSITIVE_INFINITY,
  },
})


// --------------------------------------------------
// PLANETS
// --------------------------------------------------

const planetRenderData: PlanetRenderData[] = []

for (const planet of planets) {
  const initialPosition =
    getPlanetPosition(
      planet,
      viewer.clock.currentTime
    )

  const positionProperty =
    new ConstantPositionProperty(
      initialPosition
    )

  const billboardColor =
    new ConstantProperty(
      Color.WHITE
    )

  const billboardState: BillboardState = {
    alpha: 1,
    visible: true,
  }

  const orbitPositions =
    new ConstantProperty(
      createOrbitPositions(
        planet,
        viewer.clock.currentTime
      )
    )


  // --------------------------------------------------
  // ORBIT
  // --------------------------------------------------

  viewer.entities.add({
    name:
      `${planet.name} Orbit`,

    polyline: {
      positions:
        orbitPositions,

      width: 1,

      arcType:
        ArcType.NONE,

      material:
        Color
          .fromCssColorString(
            planet.colour
          )
          .withAlpha(0.3),
    },
  })


  // --------------------------------------------------
  // PLANET
  // --------------------------------------------------

  viewer.entities.add({
    name:
      planet.name,

    position:
      positionProperty,

    ellipsoid: {
      radii:
        new Cartesian3(
          planet.radius,
          planet.radius,
          planet.radius
        ),

      material:
        Color.fromCssColorString(
          planet.colour
        ),
    },

    billboard: {
      image:
        makeCircleIcon(
          planet.colour
        ),

      width: 32,
      height: 32,

      color:
        billboardColor,

      disableDepthTestDistance:
        Number.POSITIVE_INFINITY,
    },
  })

  planetRenderData.push({
    planet,
    positionProperty,
    billboardColor,
    billboardState,
    orbitPositions,
  })
}


// --------------------------------------------------
// BILLBOARD FADE
// --------------------------------------------------

function updateBillboardFade(
  position: Cartesian3,
  radius: number,
  billboardColor: ConstantProperty,
  state: BillboardState,
  deltaSeconds: number,
  fadeOutThreshold: number = 5,
  fadeInThreshold: number = 4.5,
  fadeDuration: number = 0.4
) {
  const distance =
    Cartesian3.distance(
      viewer.camera.positionWC,
      position
    )

  const angularDiameter =
    2 *
    Math.atan(
      radius / distance
    )

  const frustum =
    viewer.camera.frustum

  const fovy =
    'fovy' in frustum
      ? frustum.fovy
      : undefined

  if (typeof fovy !== 'number') {
    return
  }

  const pixelDiameter =
    (
      angularDiameter /
      fovy
    ) *
    viewer.scene.canvas.clientHeight


  // --------------------------------------------------
  // HYSTERESIS
  // --------------------------------------------------

  if (
    state.visible &&
    pixelDiameter >= fadeOutThreshold
  ) {
    state.visible = false
  }

  if (
    !state.visible &&
    pixelDiameter <= fadeInThreshold
  ) {
    state.visible = true
  }


  // --------------------------------------------------
  // FIXED-TIME FADE
  // --------------------------------------------------

  const targetAlpha =
    state.visible
      ? 1
      : 0

  const alphaStep =
    deltaSeconds /
    fadeDuration

  if (state.alpha < targetAlpha) {
    state.alpha =
      Math.min(
        targetAlpha,
        state.alpha + alphaStep
      )
  }

  if (state.alpha > targetAlpha) {
    state.alpha =
      Math.max(
        targetAlpha,
        state.alpha - alphaStep
      )
  }

  billboardColor.setValue(
    Color.WHITE.withAlpha(
      state.alpha
    )
  )
}


// --------------------------------------------------
// UPDATE EVERYTHING EACH FRAME
// --------------------------------------------------

let previousFrameTime =
  performance.now()

let lastOrbitUpdateJulianDay =
  Number.NaN

viewer.scene.preRender.addEventListener(() => {
  const currentFrameTime =
    performance.now()

  let deltaSeconds =
    (
      currentFrameTime -
      previousFrameTime
    ) / 1000

  previousFrameTime =
    currentFrameTime

  deltaSeconds =
    Math.min(
      deltaSeconds,
      0.1
    )

  const currentTime =
    viewer.clock.currentTime

  const currentJulianDay =
    getJulianDay(
      currentTime
    )


  // --------------------------------------------------
  // SUN
  // --------------------------------------------------

  updateBillboardFade(
    sun_pos,
    sun_rad,
    sunBillboardColor,
    sunBillboardState,
    deltaSeconds
  )


  // --------------------------------------------------
  // PLANETS
  // --------------------------------------------------

  for (const renderData of planetRenderData) {
    const position =
      getPlanetPosition(
        renderData.planet,
        currentTime
      )

    renderData.positionProperty.setValue(
      position
    )

    updateBillboardFade(
      position,
      renderData.planet.radius,
      renderData.billboardColor,
      renderData.billboardState,
      deltaSeconds
    )
  }


  // --------------------------------------------------
  // UPDATE ORBIT SHAPES
  // --------------------------------------------------

  if (
    !Number.isFinite(
      lastOrbitUpdateJulianDay
    ) ||
    Math.abs(
      currentJulianDay -
      lastOrbitUpdateJulianDay
    ) >= 30
  ) {
    lastOrbitUpdateJulianDay =
      currentJulianDay

    for (const renderData of planetRenderData) {
      renderData.orbitPositions.setValue(
        createOrbitPositions(
          renderData.planet,
          currentTime
        )
      )
    }
  }
})


// --------------------------------------------------
// INITIAL CAMERA
// --------------------------------------------------

viewer.camera.lookAt(
  sun_pos,

  new HeadingPitchRange(
    0,
    -0.3,
    sun_rad * 4
  )
)
