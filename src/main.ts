import {
  ArcType,
  BoxGeometry,
  buildModuleUrl,
  Cartesian2,
  Cartesian3,
  ClockRange,
  Color,
  ColorGeometryInstanceAttribute,
  ConstantPositionProperty,
  ConstantProperty,
  CubeMapPanorama,
  Ellipsoid,
  EllipsoidGeometry,
  Entity,
  GeometryInstance,
  HeadingPitchRange,
  JulianDate,
  Material,
  MaterialAppearance,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  SceneTransforms,
  ScreenSpaceEventType,
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
viewer.camera.constrainedAxis =
  Cartesian3.clone(
    Cartesian3.UNIT_Z
  )

type SolarCameraController =
  typeof viewer.scene.screenSpaceCameraController & {
    _ellipsoid?: Ellipsoid
    _minimumCollisionTerrainHeight?: number
    _minimumPickingTerrainDistanceWithInertia?: number
    _minimumPickingTerrainHeight?: number
    _minimumTrackBallHeight?: number
    _minimumZoomRate?: number
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

const DEFAULT_CAMERA_ZOOM_FACTOR =
  cameraController.zoomFactor

const DEFAULT_MINIMUM_ZOOM_DISTANCE =
  cameraController.minimumZoomDistance

const DEFAULT_MINIMUM_ZOOM_RATE = 20

const DEFAULT_CONTROLLER_ELLIPSOID =
  cameraController._ellipsoid

const DEFAULT_MINIMUM_PICKING_TERRAIN_HEIGHT =
  cameraController.minimumPickingTerrainHeight

const DEFAULT_MINIMUM_PICKING_TERRAIN_DISTANCE_WITH_INERTIA =
  cameraController.minimumPickingTerrainDistanceWithInertia

const DEFAULT_MINIMUM_COLLISION_TERRAIN_HEIGHT =
  cameraController.minimumCollisionTerrainHeight

const DEFAULT_MINIMUM_TRACK_BALL_HEIGHT =
  cameraController.minimumTrackBallHeight

const TRACKED_BODY_ZOOM_FACTOR = 8

const SURFACE_ZOOM_LIMIT_MULTIPLIER = 1.55

const CONSTRAINED_AXIS_CLOSEUP_RANGE_MULTIPLIER = 0

const orbitOverlayCanvas =
  document.createElement('canvas')

const orbitOverlayParent =
  (
    viewer.scene.canvas.parentElement ??
    viewer.container
  ) as HTMLElement

if (
  getComputedStyle(
    orbitOverlayParent
  ).position === 'static'
) {
  orbitOverlayParent.style.position =
    'relative'
}

orbitOverlayCanvas.style.position =
  'absolute'
orbitOverlayCanvas.style.inset =
  '0'
orbitOverlayCanvas.style.width =
  '100%'
orbitOverlayCanvas.style.height =
  '100%'
orbitOverlayCanvas.style.pointerEvents =
  'none'
orbitOverlayCanvas.style.zIndex =
  '1'

orbitOverlayParent.appendChild(
  orbitOverlayCanvas
)


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

const BODY_STACK_PARTITIONS = 128
const BODY_SLICE_PARTITIONS = 128

type BodyKind =
  | 'sun'
  | 'planet'
  | 'moon'

type BodyTuningSettings = {
  iconFadeOutPixelDiameter: number
  iconFadeInPixelDiameter: number
  orbitHidePixelDiameter: number
  localViewPixelDiameter: number
  orbitGapIconPixels: number
  orbitGapMinRadius: number
  orbitGapMaxRadius: number
  orbitGapPadding: number
}

type OrbitTuningSettings = {
  alphaGapThreshold: number
  maxSegmentLengthRatio: number
  hidePlanetOrbitsInTrackedLocalView: boolean
  planetOrbitAlpha: number
  moonOrbitAlpha: number
  planetOrbitWidth: number
  moonOrbitWidth: number
}

type CameraTuningSettings = {
  constrainedAxisCloseupRangeMultiplier: number
  surfaceZoomLimitMultiplier: number
  trackedBodyZoomFactor: number
}

function getDerivedIconFadeInPixelDiameter(
  iconFadeOutPixelDiameter: number
) {
  if (iconFadeOutPixelDiameter <= 0) {
    return 0
  }

  const hysteresis =
    Math.max(
      0.5,
      iconFadeOutPixelDiameter * 0.125
    )

  return Math.max(
    0,
    Math.round(
      (
        iconFadeOutPixelDiameter -
        hysteresis
      ) *
      100
    ) / 100
  )
}

function syncDerivedBodyTuningSettings(
  settings: BodyTuningSettings
) {
  settings.iconFadeInPixelDiameter =
    getDerivedIconFadeInPixelDiameter(
      settings.iconFadeOutPixelDiameter
    )

  return settings
}

const DEFAULT_BODY_TUNING_SETTINGS:
  Record<
    BodyKind,
    BodyTuningSettings
  > = {
    sun: {
      iconFadeOutPixelDiameter: 16,
      iconFadeInPixelDiameter:
        getDerivedIconFadeInPixelDiameter(
          16
        ),
      orbitHidePixelDiameter: 0,
      localViewPixelDiameter: 16,
      orbitGapIconPixels: 32,
      orbitGapMinRadius: 2,
      orbitGapMaxRadius: 34,
      orbitGapPadding: 5,
    },

    planet: {
      iconFadeOutPixelDiameter: 16,
      iconFadeInPixelDiameter:
        getDerivedIconFadeInPixelDiameter(
          16
        ),
      orbitHidePixelDiameter: 0,
      localViewPixelDiameter: 16,
      orbitGapIconPixels: 32,
      orbitGapMinRadius: 2,
      orbitGapMaxRadius: 46,
      orbitGapPadding: 5,
    },

    moon: {
      iconFadeOutPixelDiameter: 32,
      iconFadeInPixelDiameter:
        getDerivedIconFadeInPixelDiameter(
          32
        ),
      orbitHidePixelDiameter: 32,
      localViewPixelDiameter: 16,
      orbitGapIconPixels: 20,
      orbitGapMinRadius: 3,
      orbitGapMaxRadius: 14,
      orbitGapPadding: 4,
    },
  }

const bodyTuningSettings:
  Record<
    BodyKind,
    BodyTuningSettings
  > = {
    sun: {
      ...DEFAULT_BODY_TUNING_SETTINGS.sun,
    },

    planet: {
      ...DEFAULT_BODY_TUNING_SETTINGS.planet,
    },

    moon: {
      ...DEFAULT_BODY_TUNING_SETTINGS.moon,
    },
  }

const bodyTuningOverrides =
  new Map<
    string,
    BodyTuningSettings
  >()

const DEFAULT_ORBIT_TUNING_SETTINGS:
  OrbitTuningSettings = {
  alphaGapThreshold: 0.05,
  maxSegmentLengthRatio: 0.7,
  hidePlanetOrbitsInTrackedLocalView: true,
  planetOrbitAlpha: 0.85,
  moonOrbitAlpha: 0.7,
  planetOrbitWidth: 1.5,
  moonOrbitWidth: 1,
}

const orbitTuningSettings:
  OrbitTuningSettings = {
  ...DEFAULT_ORBIT_TUNING_SETTINGS,
}

const DEFAULT_CAMERA_TUNING_SETTINGS:
  CameraTuningSettings = {
  constrainedAxisCloseupRangeMultiplier:
    CONSTRAINED_AXIS_CLOSEUP_RANGE_MULTIPLIER,

  surfaceZoomLimitMultiplier:
    SURFACE_ZOOM_LIMIT_MULTIPLIER,

  trackedBodyZoomFactor:
    TRACKED_BODY_ZOOM_FACTOR,
}

const cameraTuningSettings:
  CameraTuningSettings = {
  ...DEFAULT_CAMERA_TUNING_SETTINGS,
}

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
  massKg?: number

  a: OrbitalValue
  e: OrbitalValue
  i: OrbitalValue
  L: OrbitalValue

  longitudePerihelion: OrbitalValue
  longitudeAscendingNode: OrbitalValue
}

type MoonData = {
  name: string
  parent: string
  radius: number
  massKg?: number
  orbitRadius: number
  orbitalPeriodDays: number
  colour: string
  phaseOffset: number
  inclination: number
  longitudeAscendingNode: number
  retrograde?: boolean
  isArtificialSatellite?: boolean
}

type BodyTexture = string

type BodySpin = {
  rotationPeriodHours: number
  axialTiltDegrees: number
  phaseDegrees?: number
}

type LitBodyPrimitive = {
  material: Material
  sunDirectionEC: Cartesian3
  selfIlluminated: boolean
}

type EarthTextureTier = {
  image: string
  minimumPixelDiameter: number
  downgradePixelDiameter: number
}

type BillboardState = {
  alpha: number
  visible: boolean
  hiddenBySize: boolean
  suppressedByContext: boolean
  pixelDiameter: number
}

type OrbitGap = {
  centre: Cartesian2
  radius: number
}

type SegmentInterval = {
  start: number
  end: number
}

type OrbitGapOptions = {
  iconPixels: number
  minRadius: number
  maxRadius: number
  padding: number
}

type PlanetRenderData = {
  planet: PlanetData
  entity: Entity
  bodyPrimitive: Primitive
  positionProperty: ConstantPositionProperty
  billboardColor: ConstantProperty
  billboardState: BillboardState
  physicalPosition: Cartesian3
  currentPosition: Cartesian3
  orbitNormal: Cartesian3
  physicalOrbitPositions: Cartesian3[]
  orbitPositions: ConstantProperty
}

type MoonRenderData = {
  moon: MoonData
  parent: PlanetRenderData
  entity: Entity
  bodyPrimitive: Primitive
  positionProperty: ConstantPositionProperty
  billboardColor: ConstantProperty
  billboardState: BillboardState
  physicalPosition: Cartesian3
  currentPosition: Cartesian3
  orbitNormal: Cartesian3
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
    massKg: 1.303e22,

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

const majorMoons: MoonData[] = [
  {
    name: 'Moon',
    parent: 'Earth',
    radius: 1_737_400,
    orbitRadius: 384_400_000,
    orbitalPeriodDays: 27.3217,
    colour: '#c9c7bc',
    phaseOffset: 45,
    inclination: 5.1,
    longitudeAscendingNode: 125,
  },

  {
    name: 'ISS',
    parent: 'Earth',
    // A deliberately simple, circular low-Earth orbit. The visual model is
    // approximately the station's 109 m solar-array span rather than a sphere.
    radius: 55,
    orbitRadius: 6_771_000,
    orbitalPeriodDays: 0.0646,
    colour: '#e8eef7',
    phaseOffset: 235,
    inclination: 51.6,
    longitudeAscendingNode: 20,
    isArtificialSatellite: true,
  },

  {
    name: 'Phobos',
    parent: 'Mars',
    radius: 11_100,
    orbitRadius: 9_376_000,
    orbitalPeriodDays: 0.3189,
    colour: '#8a7a70',
    phaseOffset: 20,
    inclination: 1.1,
    longitudeAscendingNode: 35,
  },

  {
    name: 'Deimos',
    parent: 'Mars',
    radius: 6_200,
    orbitRadius: 23_463_000,
    orbitalPeriodDays: 1.2624,
    colour: '#7b706a',
    phaseOffset: 160,
    inclination: 1.8,
    longitudeAscendingNode: 80,
  },

  {
    name: 'Io',
    parent: 'Jupiter',
    radius: 1_821_600,
    orbitRadius: 421_800_000,
    orbitalPeriodDays: 1.7691,
    colour: '#d8c25b',
    phaseOffset: 15,
    inclination: 1.3,
    longitudeAscendingNode: 25,
  },

  {
    name: 'Europa',
    parent: 'Jupiter',
    radius: 1_560_800,
    orbitRadius: 671_100_000,
    orbitalPeriodDays: 3.5512,
    colour: '#d6cdbf',
    phaseOffset: 105,
    inclination: 1.8,
    longitudeAscendingNode: 35,
  },

  {
    name: 'Ganymede',
    parent: 'Jupiter',
    radius: 2_634_100,
    orbitRadius: 1_070_400_000,
    orbitalPeriodDays: 7.1546,
    colour: '#a99577',
    phaseOffset: 205,
    inclination: 2.2,
    longitudeAscendingNode: 45,
  },

  {
    name: 'Callisto',
    parent: 'Jupiter',
    radius: 2_410_300,
    orbitRadius: 1_882_700_000,
    orbitalPeriodDays: 16.6890,
    colour: '#806f63',
    phaseOffset: 300,
    inclination: 2.0,
    longitudeAscendingNode: 60,
  },

  {
    name: 'Mimas',
    parent: 'Saturn',
    radius: 198_200,
    orbitRadius: 185_540_000,
    orbitalPeriodDays: 0.9424,
    colour: '#b8b4aa',
    phaseOffset: 10,
    inclination: 1.6,
    longitudeAscendingNode: 75,
  },

  {
    name: 'Enceladus',
    parent: 'Saturn',
    radius: 252_100,
    orbitRadius: 238_040_000,
    orbitalPeriodDays: 1.3702,
    colour: '#d9dce0',
    phaseOffset: 70,
    inclination: 0.0,
    longitudeAscendingNode: 80,
  },

  {
    name: 'Tethys',
    parent: 'Saturn',
    radius: 531_100,
    orbitRadius: 294_670_000,
    orbitalPeriodDays: 1.8878,
    colour: '#d0cbc0',
    phaseOffset: 125,
    inclination: 1.1,
    longitudeAscendingNode: 85,
  },

  {
    name: 'Dione',
    parent: 'Saturn',
    radius: 561_400,
    orbitRadius: 377_420_000,
    orbitalPeriodDays: 2.7369,
    colour: '#c7c5bf',
    phaseOffset: 185,
    inclination: 0.0,
    longitudeAscendingNode: 90,
  },

  {
    name: 'Rhea',
    parent: 'Saturn',
    radius: 763_800,
    orbitRadius: 527_070_000,
    orbitalPeriodDays: 4.5182,
    colour: '#b9b7b0',
    phaseOffset: 240,
    inclination: 0.3,
    longitudeAscendingNode: 95,
  },

  {
    name: 'Titan',
    parent: 'Saturn',
    radius: 2_574_700,
    orbitRadius: 1_221_870_000,
    orbitalPeriodDays: 15.9454,
    colour: '#c99042',
    phaseOffset: 305,
    inclination: 0.3,
    longitudeAscendingNode: 105,
  },

  {
    name: 'Iapetus',
    parent: 'Saturn',
    radius: 734_500,
    orbitRadius: 3_560_820_000,
    orbitalPeriodDays: 79.3215,
    colour: '#928a7f',
    phaseOffset: 30,
    inclination: 15.5,
    longitudeAscendingNode: 120,
  },

  {
    name: 'Miranda',
    parent: 'Uranus',
    radius: 235_800,
    orbitRadius: 129_390_000,
    orbitalPeriodDays: 1.4135,
    colour: '#aaa9a2',
    phaseOffset: 40,
    inclination: 4.3,
    longitudeAscendingNode: 210,
  },

  {
    name: 'Ariel',
    parent: 'Uranus',
    radius: 578_900,
    orbitRadius: 191_020_000,
    orbitalPeriodDays: 2.5204,
    colour: '#c8c7bf',
    phaseOffset: 110,
    inclination: 0.0,
    longitudeAscendingNode: 215,
  },

  {
    name: 'Umbriel',
    parent: 'Uranus',
    radius: 584_700,
    orbitRadius: 266_300_000,
    orbitalPeriodDays: 4.1442,
    colour: '#716d68',
    phaseOffset: 175,
    inclination: 0.1,
    longitudeAscendingNode: 220,
  },

  {
    name: 'Titania',
    parent: 'Uranus',
    radius: 788_900,
    orbitRadius: 435_910_000,
    orbitalPeriodDays: 8.7059,
    colour: '#b7b3aa',
    phaseOffset: 245,
    inclination: 0.1,
    longitudeAscendingNode: 225,
  },

  {
    name: 'Oberon',
    parent: 'Uranus',
    radius: 761_400,
    orbitRadius: 583_520_000,
    orbitalPeriodDays: 13.4632,
    colour: '#9f9587',
    phaseOffset: 315,
    inclination: 0.1,
    longitudeAscendingNode: 230,
  },

  {
    name: 'Triton',
    parent: 'Neptune',
    radius: 1_353_400,
    orbitRadius: 354_760_000,
    orbitalPeriodDays: 5.8769,
    colour: '#d0aaa0',
    phaseOffset: 135,
    inclination: 157.0,
    longitudeAscendingNode: 260,
    retrograde: true,
  },

  {
    name: 'Charon',
    parent: 'Pluto',
    radius: 606_000,
    massKg: 1.586e21,
    orbitRadius: 19_596_000,
    orbitalPeriodDays: 6.3872,
    colour: '#b0a59c',
    phaseOffset: 280,
    inclination: 0.0,
    longitudeAscendingNode: 110,
  },
]

// The exact meridian phase is only important for textured bodies. Earth uses
// Greenwich sidereal time below; the remaining values keep their spin rates
// physically plausible without introducing a second time system.
const namedBodySpins: Record<string, BodySpin> = {
  Sun: {
    rotationPeriodHours: 609.12,
    axialTiltDegrees: 7.25,
  },
  Mercury: {
    rotationPeriodHours: 1_407.6,
    axialTiltDegrees: 0.03,
  },
  Venus: {
    rotationPeriodHours: -5_832.5,
    axialTiltDegrees: 177.36,
  },
  Earth: {
    rotationPeriodHours: 23.9344696,
    axialTiltDegrees: 23.43928,
  },
  Mars: {
    rotationPeriodHours: 24.6229,
    axialTiltDegrees: 25.19,
  },
  Jupiter: {
    rotationPeriodHours: 9.925,
    axialTiltDegrees: 3.13,
  },
  Saturn: {
    rotationPeriodHours: 10.656,
    axialTiltDegrees: 26.73,
  },
  Uranus: {
    rotationPeriodHours: -17.24,
    axialTiltDegrees: 97.77,
  },
  Neptune: {
    rotationPeriodHours: 16.11,
    axialTiltDegrees: 28.32,
  },
  Pluto: {
    rotationPeriodHours: -153.2928,
    axialTiltDegrees: 119.59,
  },
  Moon: {
    rotationPeriodHours: 655.728,
    axialTiltDegrees: 6.68,
  },
}


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

const J2000_JULIAN_DAY = 2_451_545.0

function getEarthGreenwichSiderealAngle(
  time: JulianDate
) {
  const daysSinceJ2000 =
    getJulianDay(time) -
    J2000_JULIAN_DAY

  const degrees =
    280.46061837 +
    360.98564736629 * daysSinceJ2000

  return normaliseRadians(
    degToRad(degrees)
  )
}

function getBodySpin(
  name: string,
  moon: MoonData | undefined = undefined
): BodySpin | undefined {
  const namedSpin =
    namedBodySpins[name]

  if (namedSpin) {
    return namedSpin
  }

  if (!moon || moon.isArtificialSatellite) {
    return undefined
  }

  return {
    rotationPeriodHours:
      moon.orbitalPeriodDays *
      24 *
      (moon.retrograde ? -1 : 1),
    axialTiltDegrees: 0,
    phaseDegrees: moon.phaseOffset,
  }
}

function getBodyRotationMatrix(
  name: string,
  time: JulianDate,
  moon: MoonData | undefined = undefined
) {
  const spin =
    getBodySpin(name, moon)

  if (!spin) {
    return undefined
  }

  const spinAngle =
    name === 'Earth'
      ? getEarthGreenwichSiderealAngle(time)
      : normaliseRadians(
        (
          (getJulianDay(time) -
            J2000_JULIAN_DAY) *
          24 /
          spin.rotationPeriodHours
        ) *
          Math.PI *
          2 +
        degToRad(spin.phaseDegrees ?? 0)
      )

  const axialTilt =
    Matrix3.fromRotationX(
      degToRad(spin.axialTiltDegrees)
    )

  const bodySpin =
    Matrix3.fromRotationZ(spinAngle)

  return Matrix3.multiply(
    axialTilt,
    bodySpin,
    new Matrix3()
  )
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

function getOrbitPlaneNormal(
  inclination: number,
  longitudeAscendingNode: number
): Cartesian3 {
  const xAxis =
    orbitalPlaneToWorld(
      1,
      0,
      inclination,
      longitudeAscendingNode,
      0
    )

  const yAxis =
    orbitalPlaneToWorld(
      0,
      1,
      inclination,
      longitudeAscendingNode,
      0
    )

  return Cartesian3.normalize(
    Cartesian3.cross(
      xAxis,
      yAxis,
      new Cartesian3()
    ),
    new Cartesian3()
  )
}

function getPlanetOrbitNormal(
  planet: PlanetData,
  time: JulianDate
): Cartesian3 {
  const elements =
    getOrbitalElements(
      planet,
      time
    )

  return getOrbitPlaneNormal(
    elements.i,
    elements.longitudeAscendingNode
  )
}

function getMoonOrbitNormal(
  moon: MoonData
): Cartesian3 {
  return getOrbitPlaneNormal(
    degToRad(
      moon.inclination
    ),
    degToRad(
      moon.longitudeAscendingNode
    )
  )
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

function getMoonRelativePosition(
  moon: MoonData,
  time: JulianDate,
  orbitRadius: number = moon.orbitRadius
): Cartesian3 {
  const daysSinceJ2000 =
    getJulianDay(
      time
    ) -
    2_451_545.0

  const direction =
    moon.retrograde
      ? -1
      : 1

  const orbitAngle =
    degToRad(
      moon.phaseOffset
    ) +
    direction *
    (
      daysSinceJ2000 /
      moon.orbitalPeriodDays
    ) *
    Math.PI *
    2

  return orbitalPlaneToWorld(
      orbitRadius * Math.cos(
        orbitAngle
      ),
      orbitRadius * Math.sin(
        orbitAngle
      ),
      degToRad(
        moon.inclination
      ),
      degToRad(
        moon.longitudeAscendingNode
      ),
      0
    )
}

function getMoonPosition(
  moon: MoonData,
  parentPosition: Cartesian3,
  time: JulianDate
): Cartesian3 {
  const relativePosition =
    getMoonRelativePosition(
      moon,
      time
    )

  return Cartesian3.add(
    parentPosition,
    relativePosition,
    new Cartesian3()
  )
}

function createMoonOrbitPositions(
  moon: MoonData,
  parentPosition: Cartesian3,
  segments: number = 144,
  orbitRadius: number = moon.orbitRadius
): Cartesian3[] {
  const positions: Cartesian3[] = []

  for (let i = 0; i <= segments; i++) {
    const orbitAngle =
      (
        i / segments
      ) *
      Math.PI *
      2

    const relativePosition =
      orbitalPlaneToWorld(
        orbitRadius * Math.cos(
          orbitAngle
        ),
        orbitRadius * Math.sin(
          orbitAngle
        ),
        degToRad(
          moon.inclination
        ),
        degToRad(
          moon.longitudeAscendingNode
        ),
        0
      )

    positions.push(
      Cartesian3.add(
        parentPosition,
        relativePosition,
        new Cartesian3()
      )
    )
  }

  return positions
}

function getPlutoCharonPhysicalPositions(
  time: JulianDate
) {
  const pluto =
    planets.find(
      (planet) =>
        planet.name === 'Pluto'
    )

  const charon =
    majorMoons.find(
      (moon) =>
        moon.name === 'Charon'
    )

  if (
    !pluto ||
    !charon ||
    !pluto.massKg ||
    !charon.massKg
  ) {
    return undefined
  }

  // Pluto's heliocentric elements locate the pair's barycentre. Their shared
  // separation then places both physical bodies on opposite sides of it.
  const barycentre =
    getPlanetPosition(
      pluto,
      time
    )

  const relativePosition =
    getMoonRelativePosition(
      charon,
      time
    )

  const totalMass =
    pluto.massKg +
    charon.massKg

  const plutoOffset =
    Cartesian3.multiplyByScalar(
      relativePosition,
      -charon.massKg / totalMass,
      new Cartesian3()
    )

  const charonOffset =
    Cartesian3.multiplyByScalar(
      relativePosition,
      pluto.massKg / totalMass,
      new Cartesian3()
    )

  return {
    barycentre,
    pluto: Cartesian3.add(
      barycentre,
      plutoOffset,
      new Cartesian3()
    ),
    charon: Cartesian3.add(
      barycentre,
      charonOffset,
      new Cartesian3()
    ),
    plutoOrbitRadius:
      charon.orbitRadius *
      charon.massKg / totalMass,
    charonOrbitRadius:
      charon.orbitRadius *
      pluto.massKg / totalMass,
  }
}

let renderOrigin =
  Cartesian3.clone(
    sun_pos
  )

function setRenderOrigin(
  physicalPosition: Cartesian3
) {
  Cartesian3.clone(
    physicalPosition,
    renderOrigin
  )
}

function toRenderPosition(
  physicalPosition: Cartesian3,
  result: Cartesian3 = new Cartesian3()
) {
  return Cartesian3.subtract(
    physicalPosition,
    renderOrigin,
    result
  )
}

function toRenderPositions(
  physicalPositions: Cartesian3[]
) {
  return physicalPositions.map(
    (position) =>
      toRenderPosition(
        position,
        new Cartesian3()
      )
  )
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

function makeIssIcon(): string {
  const svg = `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="64"
      height="64"
      viewBox="0 0 64 64"
    >
      <rect x="3" y="25" width="20" height="14" rx="1" fill="#4d82bc" />
      <rect x="41" y="25" width="20" height="14" rx="1" fill="#4d82bc" />
      <rect x="24" y="27" width="16" height="10" rx="2" fill="#eef4fa" />
      <rect x="29" y="17" width="6" height="30" rx="1" fill="#cad8e5" />
      <path d="M23 32h18M32 16v32" stroke="#152738" stroke-width="2" />
      <circle cx="32" cy="22" r="4" fill="#f5d276" />
    </svg>
  `

  return (
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(svg)
  )
}

function createTextureCanvas(
  width: number,
  height: number
) {
  const canvas =
    document.createElement(
      'canvas'
    )

  canvas.width =
    width
  canvas.height =
    height

  return canvas
}

function textureX(
  longitude: number,
  width: number
) {
  return (
    (
      longitude + 180
    ) /
    360
  ) *
  width
}

function textureY(
  latitude: number,
  height: number
) {
  return (
    (
      90 -
      latitude
    ) /
    180
  ) *
  height
}

function drawLonLatPolygon(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  points: Array<[
    longitude: number,
    latitude: number,
  ]>,
  fill: string,
  stroke: string
) {
  if (points.length === 0) {
    return
  }

  context.beginPath()

  points.forEach(
    (
      [
        longitude,
        latitude,
      ],
      index
    ) => {
      const x =
        textureX(
          longitude,
          width
        )

      const y =
        textureY(
          latitude,
          height
        )

      if (index === 0) {
        context.moveTo(
          x,
          y
        )
      } else {
        context.lineTo(
          x,
          y
        )
      }
    }
  )

  context.closePath()
  context.fillStyle =
    fill
  context.fill()
  context.strokeStyle =
    stroke
  context.lineWidth =
    3
  context.stroke()
}

function drawLonLatEllipse(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  longitude: number,
  latitude: number,
  radiusLongitude: number,
  radiusLatitude: number,
  fill: string,
  stroke?: string
) {
  context.beginPath()
  context.ellipse(
    textureX(
      longitude,
      width
    ),
    textureY(
      latitude,
      height
    ),
    (
      radiusLongitude /
      360
    ) *
    width,
    (
      radiusLatitude /
      180
    ) *
    height,
    0,
    0,
    Math.PI * 2
  )
  context.fillStyle =
    fill
  context.fill()

  if (stroke) {
    context.strokeStyle =
      stroke
    context.lineWidth =
      2
    context.stroke()
  }
}

function createStylizedEarthTexture() {
  const width =
    1024
  const height =
    512

  const canvas =
    createTextureCanvas(
      width,
      height
    )

  const context =
    canvas.getContext(
      '2d'
    )

  if (!context) {
    return canvas
  }

  const ocean =
    context.createLinearGradient(
      0,
      0,
      0,
      height
    )

  ocean.addColorStop(
    0,
    '#2b67b7'
  )
  ocean.addColorStop(
    0.5,
    '#1f83c7'
  )
  ocean.addColorStop(
    1,
    '#174b90'
  )

  context.fillStyle =
    ocean
  context.fillRect(
    0,
    0,
    width,
    height
  )

  context.fillStyle =
    'rgba(255, 255, 255, 0.08)'

  for (
    let latitude = -60;
    latitude <= 60;
    latitude += 30
  ) {
    const y =
      textureY(
        latitude,
        height
      )

    context.fillRect(
      0,
      y - 1,
      width,
      2
    )
  }

  const land =
    '#74a96a'
  const landDark =
    '#4f7f55'

  drawLonLatPolygon(
    context,
    width,
    height,
    [
      [-168, 70],
      [-135, 72],
      [-100, 58],
      [-68, 47],
      [-54, 25],
      [-80, 8],
      [-105, 14],
      [-125, 32],
      [-150, 48],
    ],
    land,
    landDark
  )

  drawLonLatPolygon(
    context,
    width,
    height,
    [
      [-82, 12],
      [-52, 2],
      [-38, -22],
      [-54, -56],
      [-73, -48],
      [-80, -18],
      [-88, 2],
    ],
    '#77b56f',
    landDark
  )

  drawLonLatPolygon(
    context,
    width,
    height,
    [
      [-55, 76],
      [-28, 72],
      [-18, 58],
      [-42, 52],
      [-62, 62],
    ],
    '#d8e6d6',
    '#a9beb0'
  )

  drawLonLatPolygon(
    context,
    width,
    height,
    [
      [-12, 36],
      [8, 58],
      [52, 60],
      [104, 52],
      [150, 62],
      [172, 48],
      [126, 18],
      [74, 6],
      [48, 22],
      [26, 30],
      [8, 34],
    ],
    '#85b86d',
    landDark
  )

  drawLonLatPolygon(
    context,
    width,
    height,
    [
      [-18, 34],
      [14, 30],
      [34, 8],
      [30, -30],
      [12, -36],
      [-8, -8],
      [-20, 18],
    ],
    '#b3a160',
    '#746b43'
  )

  drawLonLatPolygon(
    context,
    width,
    height,
    [
      [110, -12],
      [152, -18],
      [154, -39],
      [126, -45],
      [112, -28],
    ],
    '#b69a62',
    '#776845'
  )

  drawLonLatPolygon(
    context,
    width,
    height,
    [
      [-180, -72],
      [-100, -66],
      [-20, -70],
      [60, -66],
      [180, -74],
      [180, -90],
      [-180, -90],
    ],
    '#d8e2de',
    '#a9b8b5'
  )

  context.fillStyle =
    'rgba(255, 255, 255, 0.18)'

  for (const cloud of [
    [-150, 26, 28, 7],
    [-24, -4, 34, 8],
    [62, 48, 42, 7],
    [146, -26, 30, 6],
  ] as Array<[
    number,
    number,
    number,
    number,
  ]>) {
    drawLonLatEllipse(
      context,
      width,
      height,
      cloud[0],
      cloud[1],
      cloud[2],
      cloud[3],
      'rgba(255, 255, 255, 0.18)'
    )
  }

  return canvas
}

function createStylizedMoonTexture() {
  const width =
    1024
  const height =
    512

  const canvas =
    createTextureCanvas(
      width,
      height
    )

  const context =
    canvas.getContext(
      '2d'
    )

  if (!context) {
    return canvas
  }

  const surface =
    context.createLinearGradient(
      0,
      0,
      width,
      height
    )

  surface.addColorStop(
    0,
    '#d9d7ce'
  )
  surface.addColorStop(
    0.48,
    '#aaa79d'
  )
  surface.addColorStop(
    1,
    '#ebe7dc'
  )

  context.fillStyle =
    surface
  context.fillRect(
    0,
    0,
    width,
    height
  )

  for (const mare of [
    [-18, 18, 28, 14],
    [22, 8, 22, 11],
    [58, 24, 18, 9],
    [-54, -18, 18, 10],
  ] as Array<[
    number,
    number,
    number,
    number,
  ]>) {
    drawLonLatEllipse(
      context,
      width,
      height,
      mare[0],
      mare[1],
      mare[2],
      mare[3],
      'rgba(112, 111, 106, 0.38)'
    )
  }

  for (const crater of [
    [-112, 42, 9],
    [-72, 10, 12],
    [-36, -34, 7],
    [4, 36, 8],
    [40, -18, 10],
    [92, 18, 7],
    [128, -38, 11],
    [152, 46, 6],
  ] as Array<[
    number,
    number,
    number,
  ]>) {
    drawLonLatEllipse(
      context,
      width,
      height,
      crater[0],
      crater[1],
      crater[2],
      crater[2] * 0.55,
      'rgba(70, 70, 66, 0.22)',
      'rgba(245, 242, 232, 0.42)'
    )
  }

  context.fillStyle =
    'rgba(255, 255, 255, 0.1)'

  for (
    let x = 0;
    x < width;
    x += 24
  ) {
    for (
      let y = (
        x % 48
      );
      y < height;
      y += 48
    ) {
      context.fillRect(
        x,
        y,
        2,
        2
      )
    }
  }

  return canvas
}

const earthTextureTiers: EarthTextureTier[] = [
  {
    image:
      '/textures/earth-natural-2048.jpg',
    minimumPixelDiameter: 0,
    downgradePixelDiameter: 0,
  },

  {
    image:
      '/textures/earth-natural-4096.jpg',
    minimumPixelDiameter: 220,
    downgradePixelDiameter: 160,
  },

  {
    image:
      '/textures/earth-natural-8192.jpg',
    minimumPixelDiameter: 520,
    downgradePixelDiameter: 420,
  },
]

let activeEarthTextureTierIndex =
  earthTextureTiers.length - 1

const initialEarthSurfaceTexture:
  BodyTexture =
  earthTextureTiers[
    activeEarthTextureTierIndex
  ]?.image ??
  createStylizedEarthTexture().toDataURL()

for (const tier of earthTextureTiers) {
  const image =
    new Image()

  image.src =
    tier.image
}

const moonSurfaceTexture =
  createStylizedMoonTexture().toDataURL()

const approximateBodyTextures =
  new Map<string, string>()

const litBodyPrimitives =
  new Map<Primitive, LitBodyPrimitive>()

const bodyDayNightMaterialSource = `
uniform sampler2D image;
uniform vec3 sunDirectionEC;
uniform float selfIlluminated;

czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec4 surface = texture(image, materialInput.st);
  float solarFacing = dot(
    normalize(materialInput.normalEC),
    normalize(sunDirectionEC)
  );
  float daylight = smoothstep(-0.04, 0.08, solarFacing);
  float illumination = mix(0.006, 1.0, daylight);
  illumination = mix(illumination, 1.0, selfIlluminated);
  material.diffuse = surface.rgb * illumination;
  material.emission = surface.rgb * selfIlluminated;
  material.specular = 0.0;
  material.alpha = surface.a;
  return material;
}
`

function getTextureNoise(
  bodyName: string,
  index: number
) {
  let hash =
    index * 374761393

  for (
    let characterIndex = 0;
    characterIndex < bodyName.length;
    characterIndex += 1
  ) {
    hash =
      (hash * 31 + bodyName.charCodeAt(characterIndex)) |
      0
  }

  hash =
    (hash ^ (hash >>> 13)) * 1274126177

  return (
    (hash ^ (hash >>> 16)) >>> 0
  ) / 4_294_967_295
}

function getApproximateBodyTexture(
  bodyName: string,
  colour: string
) {
  const textureKey =
    `${bodyName}:${colour}`

  const existingTexture =
    approximateBodyTextures.get(textureKey)

  if (existingTexture) {
    return existingTexture
  }

  const texture =
    createTextureCanvas(
      512,
      256
    )

  const context =
    texture.getContext('2d')

  if (context) {
    context.fillStyle = colour
    context.fillRect(
      0,
      0,
      texture.width,
      texture.height
    )

    const isGasGiant =
      [
        'Jupiter',
        'Saturn',
        'Uranus',
        'Neptune',
      ].includes(bodyName)

    if (isGasGiant) {
      const bandCount =
        bodyName === 'Jupiter'
          ? 18
          : 12

      for (
        let index = 0;
        index < bandCount;
        index += 1
      ) {
        const y =
          (index / bandCount) *
          texture.height

        context.fillStyle =
          index % 2 === 0
            ? 'rgba(255, 255, 255, 0.14)'
            : 'rgba(22, 38, 54, 0.13)'
        context.fillRect(
          0,
          y,
          texture.width,
          texture.height / bandCount + 1
        )
      }

      if (bodyName === 'Jupiter') {
        context.fillStyle =
          'rgba(144, 67, 43, 0.7)'
        context.beginPath()
        context.ellipse(
          texture.width * 0.72,
          texture.height * 0.57,
          26,
          12,
          -0.08,
          0,
          Math.PI * 2
        )
        context.fill()
      }
    } else if (bodyName === 'Sun') {
      const glow =
        context.createRadialGradient(
          texture.width * 0.5,
          texture.height * 0.5,
          10,
          texture.width * 0.5,
          texture.height * 0.5,
          texture.width * 0.5
        )
      glow.addColorStop(0, '#fff1a0')
      glow.addColorStop(0.42, '#ffc533')
      glow.addColorStop(1, '#e76d16')
      context.fillStyle = glow
      context.fillRect(0, 0, texture.width, texture.height)
    } else {
      for (
        let index = 0;
        index < 48;
        index += 1
      ) {
        const x =
          getTextureNoise(bodyName, index) *
          texture.width
        const y =
          getTextureNoise(bodyName, index + 97) *
          texture.height
        const radius =
          2 +
          getTextureNoise(bodyName, index + 211) * 14

        context.fillStyle =
          index % 2 === 0
            ? 'rgba(255, 255, 255, 0.12)'
            : 'rgba(40, 35, 30, 0.18)'
        context.beginPath()
        context.ellipse(
          x,
          y,
          radius,
          radius * 0.55,
          0,
          0,
          Math.PI * 2
        )
        context.fill()
      }

      if (bodyName === 'Mars') {
        context.fillStyle =
          'rgba(240, 225, 208, 0.42)'
        context.fillRect(0, 0, texture.width, 20)
        context.fillRect(
          0,
          texture.height - 18,
          texture.width,
          18
        )
      }
    }
  }

  const dataUrl =
    texture.toDataURL()

  approximateBodyTextures.set(textureKey, dataUrl)

  return dataUrl
}

function createBodyDayNightMaterial(
  texture: BodyTexture,
  selfIlluminated: boolean
) {
  const sunDirectionEC =
    new Cartesian3(0, 0, 1)

  const material =
    new Material({
      translucent: false,
      fabric: {
        type: 'SolarDayNight',
        uniforms: {
          image: texture,
          sunDirectionEC,
          selfIlluminated:
            selfIlluminated ? 1 : 0,
        },
        source:
          bodyDayNightMaterialSource,
      },
    })

  return {
    material,
    sunDirectionEC,
  }
}

function createBodyPrimitive(
  entity: Entity,
  radius: number,
  colour: string,
  position: Cartesian3,
  texture:
    | BodyTexture
    | undefined =
    undefined,
  selfIlluminated = false
) {
  const surfaceTexture =
    texture ??
    getApproximateBodyTexture(
      entity.name ?? 'Body',
      colour
    )

  const {
    material,
    sunDirectionEC,
  } = createBodyDayNightMaterial(
    surfaceTexture,
    selfIlluminated
  )

  const primitive =
    viewer.scene.primitives.add(
    new Primitive({
      geometryInstances:
        new GeometryInstance({
          id:
            entity,

          geometry:
            new EllipsoidGeometry({
              radii:
                new Cartesian3(
                  radius,
                  radius,
                  radius
                ),

              stackPartitions:
                BODY_STACK_PARTITIONS,

              slicePartitions:
                BODY_SLICE_PARTITIONS,

              vertexFormat:
                MaterialAppearance
                  .MaterialSupport
                  .TEXTURED
                  .vertexFormat,
            }),
        }),

      appearance:
        new MaterialAppearance({
          closed: true,
          translucent: false,
          flat: true,
          materialSupport:
            MaterialAppearance
              .MaterialSupport
              .TEXTURED,
          material,
        }),

      asynchronous:
        false,

      cull:
        false,

      modelMatrix:
        Matrix4.fromTranslation(
          position
        ),
    })
  ) as Primitive

  litBodyPrimitives.set(
    primitive,
    {
      material,
      sunDirectionEC,
      selfIlluminated,
    }
  )

  return primitive
}

function createIssPrimitive(
  entity: Entity,
  position: Cartesian3
) {
  const createBoxInstance = (
    dimensions: Cartesian3,
    offset: Cartesian3,
    colour: string
  ) =>
    new GeometryInstance({
      id: entity,
      geometry: BoxGeometry.fromDimensions({
        dimensions,
        vertexFormat:
          PerInstanceColorAppearance
            .VERTEX_FORMAT,
      }),
      modelMatrix:
        Matrix4.fromTranslation(
          offset
        ),
      attributes: {
        color:
          ColorGeometryInstanceAttribute
            .fromColor(
              Color.fromCssColorString(
                colour
              )
            ),
      },
    })

  return viewer.scene.primitives.add(
    new Primitive({
      geometryInstances: [
        createBoxInstance(
          new Cartesian3(18, 7, 7),
          Cartesian3.ZERO,
          '#e8eef7'
        ),
        createBoxInstance(
          new Cartesian3(44, 3, 0.5),
          new Cartesian3(-31, 0, 0),
          '#3d75b8'
        ),
        createBoxInstance(
          new Cartesian3(44, 3, 0.5),
          new Cartesian3(31, 0, 0),
          '#3d75b8'
        ),
      ],
      appearance:
        new PerInstanceColorAppearance({
          closed: true,
          translucent: false,
        }),
      asynchronous: false,
      cull: false,
      modelMatrix:
        Matrix4.fromTranslation(
          position
        ),
    })
  ) as Primitive
}

function createSaturnRingsPrimitive(
  entity: Entity,
  radius: number,
  position: Cartesian3
) {
  const ringBands = [
    {
      innerRadius: radius * 1.28,
      outerRadius: radius * 1.42,
      colour: '#8e7b56',
      alpha: 0.45,
    },
    {
      innerRadius: radius * 1.47,
      outerRadius: radius * 1.82,
      colour: '#d9c48f',
      alpha: 0.72,
    },
    {
      innerRadius: radius * 1.86,
      outerRadius: radius * 2.12,
      colour: '#a58d66',
      alpha: 0.5,
    },
  ]
  const segments = 112
  const geometryInstances: GeometryInstance[] = []

  for (const band of ringBands) {
    const centreRadius =
      (band.innerRadius + band.outerRadius) / 2
    const radialWidth =
      band.outerRadius - band.innerRadius

    for (
      let index = 0;
      index < segments;
      index += 1
    ) {
      const angle =
        (index / segments) * Math.PI * 2
      const arcLength =
        (Math.PI * 2 * centreRadius) / segments * 1.08
      const offset =
        new Cartesian3(
          Math.cos(angle) * centreRadius,
          Math.sin(angle) * centreRadius,
          0
        )
      const rotation =
        Matrix3.fromRotationZ(
          angle + Math.PI / 2,
          new Matrix3()
        )

      geometryInstances.push(
        new GeometryInstance({
          id: entity,
          geometry: BoxGeometry.fromDimensions({
            dimensions: new Cartesian3(
              arcLength,
              radialWidth,
              Math.max(radius * 0.003, 20_000)
            ),
            vertexFormat:
              PerInstanceColorAppearance
                .VERTEX_FORMAT,
          }),
          modelMatrix:
            Matrix4.fromRotationTranslation(
              rotation,
              offset
            ),
          attributes: {
            color:
              ColorGeometryInstanceAttribute
                .fromColor(
                  Color
                    .fromCssColorString(
                      band.colour
                    )
                    .withAlpha(
                      band.alpha
                    )
                ),
          },
        })
      )
    }
  }

  return viewer.scene.primitives.add(
    new Primitive({
      geometryInstances,
      appearance:
        new PerInstanceColorAppearance({
          closed: false,
          translucent: true,
          flat: true,
        }),
      asynchronous: false,
      cull: false,
      modelMatrix:
        Matrix4.fromTranslation(
          position
        ),
    })
  ) as Primitive
}

function updateBodyPrimitiveTransform(
  primitive: Primitive,
  position: Cartesian3,
  rotation: Matrix3 | undefined =
    undefined
) {
  if (rotation) {
    Matrix4.fromRotationTranslation(
      rotation,
      position,
      primitive.modelMatrix
    )

    return
  }

  Matrix4.fromTranslation(position, primitive.modelMatrix)
}

function updateBodyDayNightMaterial(
  primitive: Primitive,
  bodyPosition: Cartesian3
) {
  const lighting =
    litBodyPrimitives.get(primitive)

  if (!lighting || lighting.selfIlluminated) {
    return
  }

  const sunDirectionWC =
    Cartesian3.subtract(
      sunRenderPosition,
      bodyPosition,
      new Cartesian3()
    )

  if (Cartesian3.magnitude(sunDirectionWC) < 1) {
    return
  }

  Matrix4.multiplyByPointAsVector(
    viewer.camera.viewMatrix,
    sunDirectionWC,
    lighting.sunDirectionEC
  )

  Cartesian3.normalize(
    lighting.sunDirectionEC,
    lighting.sunDirectionEC
  )

  // Material uniforms are copied when Cesium builds the fabric. Reassign the
  // updated vector so each frame receives the current sun direction.
  lighting.material.uniforms.sunDirectionEC =
    lighting.sunDirectionEC
}

function setBodyPrimitiveTexture(
  primitive: Primitive,
  texture: BodyTexture
) {
  const appearance =
    primitive.appearance as
      | MaterialAppearance
      | undefined

  const material =
    appearance?.material

  if (!material?.uniforms) {
    return
  }

  material.uniforms.image =
    texture
}


// --------------------------------------------------
// SUN
// --------------------------------------------------

const sunBillboardColor =
  new ConstantProperty(
    Color.WHITE
  )

const sunPositionProperty =
  new ConstantPositionProperty(
    toRenderPosition(
      sun_pos
    )
  )

let sunRenderPosition =
  toRenderPosition(
    sun_pos
  )

const sunBillboardState: BillboardState = {
  alpha: 1,
  visible: true,
  hiddenBySize: false,
  suppressedByContext: false,
  pixelDiameter: 0,
}

const trackableBodies =
  new Set<Entity>()

const sunEntity = viewer.entities.add({
  name: 'Sun',

  position:
    sunPositionProperty,

  ellipsoid: {
    show:
      false,

    radii:
      new Cartesian3(
        sun_rad,
        sun_rad,
        sun_rad
      ),

    stackPartitions:
      BODY_STACK_PARTITIONS,

    slicePartitions:
      BODY_SLICE_PARTITIONS,

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

const sunBodyPrimitive =
  createBodyPrimitive(
    sunEntity,
    sun_rad,
    '#ffb300',
    sunRenderPosition,
    undefined,
    true
  )

trackableBodies.add(
  sunEntity
)


// --------------------------------------------------
// PLANETS
// --------------------------------------------------

const planetRenderData: PlanetRenderData[] = []

let saturnRingPrimitive:
  | Primitive
  | undefined

for (const planet of planets) {
  const initialPhysicalPosition =
    getPlanetPosition(
      planet,
      viewer.clock.currentTime
    )

  const initialPosition =
    toRenderPosition(
      initialPhysicalPosition
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
    hiddenBySize: false,
    suppressedByContext: false,
    pixelDiameter: 0,
  }

  const physicalOrbitPositions =
    createOrbitPositions(
      planet,
      viewer.clock.currentTime
    )

  const orbitPositions =
    new ConstantProperty(
      toRenderPositions(
        physicalOrbitPositions
      )
    )


  // --------------------------------------------------
  // ORBIT
  // --------------------------------------------------

  viewer.entities.add({
    name:
      `${planet.name} Orbit`,

    polyline: {
      show:
        false,

      positions:
        orbitPositions,

      width: 2,

      arcType:
        ArcType.NONE,

      material:
        Color
          .fromCssColorString(
            planet.colour
          )
          .withAlpha(0.75),
    },
  })


  // --------------------------------------------------
  // PLANET
  // --------------------------------------------------

  const planetEntity = viewer.entities.add({
    name:
      planet.name,

    position:
      positionProperty,

    ellipsoid: {
      show:
        false,

      radii:
        new Cartesian3(
          planet.radius,
          planet.radius,
          planet.radius
        ),

      stackPartitions:
        BODY_STACK_PARTITIONS,

      slicePartitions:
        BODY_SLICE_PARTITIONS,

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

  const bodyPrimitive =
    createBodyPrimitive(
      planetEntity,
      planet.radius,
      planet.colour,
      initialPosition,
      planet.name === 'Earth'
        ? initialEarthSurfaceTexture
        : undefined
    )

  if (planet.name === 'Saturn') {
    saturnRingPrimitive =
      createSaturnRingsPrimitive(
        planetEntity,
        planet.radius,
        initialPosition
      )
  }

  trackableBodies.add(
    planetEntity
  )

  planetRenderData.push({
    planet,
    entity: planetEntity,
    bodyPrimitive,
    positionProperty,
    billboardColor,
    billboardState,
    physicalPosition:
      initialPhysicalPosition,
    currentPosition: initialPosition,
    orbitNormal:
      getPlanetOrbitNormal(
        planet,
        viewer.clock.currentTime
      ),
    physicalOrbitPositions,
    orbitPositions,
  })
}

const earthRenderData =
  planetRenderData.find(
    (renderData) =>
      renderData.planet.name ===
        'Earth'
  )

const moonRenderData: MoonRenderData[] = []

for (const moon of majorMoons) {
  const parent =
    planetRenderData.find(
      (
        renderData
      ) =>
        renderData.planet.name === moon.parent
    )

  if (!parent) {
    continue
  }

  const initialPhysicalPosition =
    getMoonPosition(
      moon,
      parent.physicalPosition,
      viewer.clock.currentTime
    )

  const initialPosition =
    toRenderPosition(
      initialPhysicalPosition
    )

  const positionProperty =
    new ConstantPositionProperty(
      initialPosition
    )

  const billboardColor =
    new ConstantProperty(
      Color.TRANSPARENT
    )

  const billboardState: BillboardState = {
    alpha: 0,
    visible: false,
    hiddenBySize: false,
    suppressedByContext: false,
    pixelDiameter: 0,
  }

  const orbitPositions =
    new ConstantProperty(
      toRenderPositions(
        createMoonOrbitPositions(
          moon,
          parent.physicalPosition
        )
      )
    )


  // --------------------------------------------------
  // MOON ORBIT
  // --------------------------------------------------

  viewer.entities.add({
    name:
      `${moon.name} Orbit`,

    polyline: {
      show:
        false,

      positions:
        orbitPositions,

      width: 1.5,

      arcType:
        ArcType.NONE,

      material:
        Color
          .fromCssColorString(
            moon.colour
          )
          .withAlpha(0.65),
    },
  })


  // --------------------------------------------------
  // MOON
  // --------------------------------------------------

  const moonEntity = viewer.entities.add({
    name:
      moon.name,

    position:
      positionProperty,

    ellipsoid: {
      show:
        false,

      radii:
        new Cartesian3(
          moon.radius,
          moon.radius,
          moon.radius
        ),

      stackPartitions:
        BODY_STACK_PARTITIONS,

      slicePartitions:
        BODY_SLICE_PARTITIONS,

      material:
        Color.fromCssColorString(
          moon.colour
        ),
    },

    billboard: {
      image:
        moon.isArtificialSatellite
          ? makeIssIcon()
          : makeCircleIcon(
              moon.colour
            ),

      width:
        moon.isArtificialSatellite
          ? 34
          : 20,
      height:
        moon.isArtificialSatellite
          ? 34
          : 20,

      color:
        billboardColor,

      disableDepthTestDistance:
        Number.POSITIVE_INFINITY,
    },
  })

  const bodyPrimitive =
    moon.isArtificialSatellite
      ? createIssPrimitive(
        moonEntity,
        initialPosition
      )
      : createBodyPrimitive(
        moonEntity,
        moon.radius,
        moon.colour,
        initialPosition,
        moon.name === 'Moon'
          ? moonSurfaceTexture
          : undefined
      )

  trackableBodies.add(
    moonEntity
  )

  moonRenderData.push({
    moon,
    parent,
    entity: moonEntity,
    bodyPrimitive,
    positionProperty,
    billboardColor,
    billboardState,
    physicalPosition:
      initialPhysicalPosition,
    currentPosition: initialPosition,
    orbitNormal:
      getMoonOrbitNormal(
        moon
      ),
    orbitPositions,
  })
}


// --------------------------------------------------
// LIVE TUNING PANEL
// --------------------------------------------------

type SettingsTarget = {
  id: string
  label: string
  kind: BodyKind
  bodyName?: string
}

type RefreshableControl = {
  refresh: () => void
}

const settingsTargets: SettingsTarget[] = [
  {
    id: 'default:sun',
    label: 'Sun defaults',
    kind: 'sun',
  },

  {
    id: 'default:planet',
    label: 'Planet defaults',
    kind: 'planet',
  },

  {
    id: 'default:moon',
    label: 'Moon defaults',
    kind: 'moon',
  },

  {
    id: 'body:Sun',
    label: 'Sun',
    kind: 'sun',
    bodyName: 'Sun',
  },

  ...planetRenderData.map(
    (renderData) => ({
      id:
        `body:${renderData.planet.name}`,
      label:
        renderData.planet.name,
      kind:
        'planet' as BodyKind,
      bodyName:
        renderData.planet.name,
    })
  ),

  ...moonRenderData.map(
    (renderData) => ({
      id:
        `body:${renderData.moon.name}`,
      label:
        `${renderData.moon.name} (${renderData.parent.planet.name})`,
      kind:
        'moon' as BodyKind,
      bodyName:
        renderData.moon.name,
    })
  ),
]

let activeSettingsTarget =
  settingsTargets[2]

const refreshableControls:
  RefreshableControl[] = []

const settingsButton =
  document.createElement(
    'button'
  )

settingsButton.type =
  'button'
settingsButton.className =
  'solar-settings-button'
settingsButton.textContent =
  'Settings'

const settingsPanel =
  document.createElement(
    'section'
  )

settingsPanel.className =
  'solar-settings-panel'
settingsPanel.hidden =
  true
settingsPanel.setAttribute(
  'aria-label',
  'Solar tuning settings'
)

const settingsHeader =
  document.createElement(
    'div'
  )

settingsHeader.className =
  'solar-settings-header'

const settingsTitle =
  document.createElement(
    'h2'
  )

settingsTitle.textContent =
  'Live settings'

const settingsCloseButton =
  document.createElement(
    'button'
  )

settingsCloseButton.type =
  'button'
settingsCloseButton.textContent =
  'Close'

settingsHeader.append(
  settingsTitle,
  settingsCloseButton
)

const settingsTargetRow =
  document.createElement(
    'label'
  )

settingsTargetRow.className =
  'solar-setting-row solar-setting-row-select'

const settingsTargetLabel =
  document.createElement(
    'span'
  )

settingsTargetLabel.textContent =
  'Target'
configureSettingLabel(
  settingsTargetLabel,
  'Choose whether the per-body controls edit a default body type or one specific body.'
)

const settingsTargetSelect =
  document.createElement(
    'select'
  )

for (const target of settingsTargets) {
  const option =
    document.createElement(
      'option'
    )

  option.value =
    target.id
  option.textContent =
    target.label

  settingsTargetSelect.appendChild(
    option
  )
}

settingsTargetSelect.value =
  activeSettingsTarget.id

settingsTargetRow.append(
  settingsTargetLabel,
  settingsTargetSelect
)

const settingsActions =
  document.createElement(
    'div'
  )

settingsActions.className =
  'solar-settings-actions'

const settingsUseSelectedButton =
  document.createElement(
    'button'
  )

settingsUseSelectedButton.type =
  'button'
settingsUseSelectedButton.textContent =
  'Switch to selected body'

const settingsResetButton =
  document.createElement(
    'button'
  )

settingsResetButton.type =
  'button'
settingsResetButton.textContent =
  "Reset this body's settings"

const settingsResetGlobalButton =
  document.createElement(
    'button'
  )

settingsResetGlobalButton.type =
  'button'
settingsResetGlobalButton.textContent =
  'Reset global settings'

const settingsCopyButton =
  document.createElement(
    'button'
  )

settingsCopyButton.type =
  'button'
settingsCopyButton.textContent =
  'Copy settings dump'

settingsActions.append(
  settingsUseSelectedButton,
  settingsResetButton,
  settingsResetGlobalButton,
  settingsCopyButton
)

const settingsCopyStatus =
  document.createElement(
    'div'
  )

settingsCopyStatus.className =
  'solar-settings-status'
settingsCopyStatus.setAttribute(
  'aria-live',
  'polite'
)

const settingsScopeNote =
  document.createElement(
    'p'
  )

settingsScopeNote.className =
  'solar-settings-note'
settingsScopeNote.textContent =
  'Per-body sections edit the selected target. Global sections affect every body.'

function getSettingsTargetById(
  targetId: string
) {
  return (
    settingsTargets.find(
      (target) =>
        target.id === targetId
    ) ??
    settingsTargets[2]
  )
}

function getActiveBodySettings() {
  if (
    activeSettingsTarget.bodyName
  ) {
    return getBodyTuningSettings(
      activeSettingsTarget.bodyName,
      activeSettingsTarget.kind
    )
  }

  return bodyTuningSettings[
    activeSettingsTarget.kind
  ]
}

function getMutableActiveBodySettings() {
  if (
    activeSettingsTarget.bodyName
  ) {
    const existingOverride =
      bodyTuningOverrides.get(
        activeSettingsTarget.bodyName
      )

    if (existingOverride) {
      return existingOverride
    }

    const override =
      cloneBodyTuningSettings(
        getBodyTuningSettings(
          activeSettingsTarget.bodyName,
          activeSettingsTarget.kind
        )
      )

    bodyTuningOverrides.set(
      activeSettingsTarget.bodyName,
      override
    )

    return override
  }

  return bodyTuningSettings[
    activeSettingsTarget.kind
  ]
}

function refreshSettingsControls() {
  for (const control of refreshableControls) {
    control.refresh()
  }
}

let settingsCopyStatusTimer:
  number |
  undefined

function showSettingsCopyStatus(
  text: string
) {
  settingsCopyStatus.textContent =
    text

  if (
    settingsCopyStatusTimer !==
    undefined
  ) {
    window.clearTimeout(
      settingsCopyStatusTimer
    )
  }

  settingsCopyStatusTimer =
    window.setTimeout(
      () => {
        settingsCopyStatus.textContent =
          ''
        settingsCopyStatusTimer =
          undefined
      },
      2500
    )
}

function createSettingsDump() {
  const bodyDefaults:
    Record<
      BodyKind,
      BodyTuningSettings
    > = {
      sun:
        cloneBodyTuningSettings(
          bodyTuningSettings.sun
        ),
      planet:
        cloneBodyTuningSettings(
          bodyTuningSettings.planet
        ),
      moon:
        cloneBodyTuningSettings(
          bodyTuningSettings.moon
        ),
    }

  const bodyOverrides =
    Object.fromEntries(
      Array
        .from(
          bodyTuningOverrides.entries()
        )
        .sort(
          ([left], [right]) =>
            left.localeCompare(
              right
            )
        )
        .map(
          ([
            bodyName,
            settings,
          ]) => [
            bodyName,
            cloneBodyTuningSettings(
              settings
            ),
          ]
        )
    )

  const resolvedBodies =
    Object.fromEntries(
      settingsTargets
        .filter(
          (target) =>
            Boolean(
              target.bodyName
            )
        )
        .map(
          (target) => {
            const bodyName =
              target.bodyName ??
              target.label

            return [
              bodyName,
              {
                label:
                  target.label,
                kind:
                  target.kind,
                settings:
                  cloneBodyTuningSettings(
                    getBodyTuningSettings(
                      bodyName,
                      target.kind
                    )
                  ),
              },
            ]
          }
        )
    )

  return JSON.stringify(
    {
      version: 1,
      activeTarget:
        {
          id:
            activeSettingsTarget.id,
          label:
            activeSettingsTarget.label,
          kind:
            activeSettingsTarget.kind,
          bodyName:
            activeSettingsTarget.bodyName,
        },
      bodyDefaults,
      bodyOverrides,
      resolvedBodies,
      globalOrbit:
        {
          ...orbitTuningSettings,
        },
      globalCamera:
        {
          ...cameraTuningSettings,
        },
    },
    null,
    2
  )
}

function fallbackCopyTextToClipboard(
  text: string
) {
  const textarea =
    document.createElement(
      'textarea'
    )

  textarea.value =
    text
  textarea.setAttribute(
    'readonly',
    'true'
  )
  textarea.style.position =
    'fixed'
  textarea.style.left =
    '-9999px'
  textarea.style.top =
    '0'

  document.body.appendChild(
    textarea
  )
  textarea.select()

  const copied =
    document.execCommand(
      'copy'
    )

  textarea.remove()

  if (!copied) {
    throw new Error(
      'Copy command was not available.'
    )
  }
}

async function copyTextToClipboard(
  text: string
) {
  if (
    navigator.clipboard &&
    navigator.clipboard.writeText
  ) {
    try {
      await navigator
        .clipboard
        .writeText(
          text
        )
      return
    } catch {
      // Fall back for browsers that expose the API
      // but deny writes outside their preferred path.
    }
  }

  fallbackCopyTextToClipboard(
    text
  )
}

function createSettingsSection(
  title: string
) {
  const section =
    document.createElement(
      'details'
    )

  section.className =
    'solar-settings-section'
  section.open =
    false

  const summary =
    document.createElement(
      'summary'
    )

  summary.textContent =
    title

  section.appendChild(
    summary
  )

  return section
}

function formatSettingNumber(
  value: number
) {
  return Number.isInteger(
    value
  )
    ? value.toString()
    : Number(
      value.toFixed(
        2
      )
    ).toString()
}

function configureSettingLabel(
  label: HTMLElement,
  tooltipText: string
) {
  label.className =
    'solar-setting-label'
  label.title =
    tooltipText
  label.tabIndex =
    0
}

type NumberControlOptions = {
  clamp?: boolean
}

function createNumberControl(
  section: HTMLElement,
  labelText: string,
  tooltipText: string,
  min: number,
  max: number,
  step: number,
  getValue: () => number,
  setValue: (value: number) => void,
  options: NumberControlOptions = {}
) {
  const clamp =
    options.clamp ?? true

  const row =
    document.createElement(
      'label'
    )

  row.className =
    'solar-setting-row'

  const label =
    document.createElement(
      'span'
    )

  label.textContent =
    labelText
  configureSettingLabel(
    label,
    tooltipText
  )

  const controls =
    document.createElement(
      'div'
    )

  controls.className =
    'solar-setting-control'

  const range =
    document.createElement(
      'input'
    )

  range.type =
    'range'
  range.min =
    min.toString()
  range.max =
    max.toString()
  range.step =
    step.toString()

  const number =
    document.createElement(
      'input'
    )

  number.type =
    'number'
  number.step =
    step.toString()

  if (clamp) {
    number.min =
      min.toString()
    number.max =
      max.toString()
  }

  const setInputs =
    (value: number) => {
      const text =
        value.toString()

      range.value =
        text
      number.value =
        text
    }

  const commitValue =
    (value: number) => {
      if (
        !Number.isFinite(
          value
        )
      ) {
        return
      }

      const nextValue =
        clamp
          ? Math.min(
              max,
              Math.max(
                min,
                value
              )
            )
          : value

      setValue(
        nextValue
      )
      setInputs(
        nextValue
      )
    }

  range.addEventListener(
    'input',
    () => {
      commitValue(
        Number(
          range.value
        )
      )
    }
  )

  number.addEventListener(
    'input',
    () => {
      commitValue(
        Number(
          number.value
        )
      )
    }
  )

  controls.append(
    range,
    number
  )

  row.append(
    label,
    controls
  )

  section.appendChild(
    row
  )

  const control = {
    refresh: () => {
      setInputs(
        getValue()
      )
    },
  }

  refreshableControls.push(
    control
  )

  control.refresh()
}

function createReadOnlyNumberControl(
  section: HTMLElement,
  labelText: string,
  tooltipText: string,
  getValue: () => number
) {
  const row =
    document.createElement(
      'div'
    )

  row.className =
    'solar-setting-row'

  const label =
    document.createElement(
      'span'
    )

  label.textContent =
    labelText
  configureSettingLabel(
    label,
    tooltipText
  )

  const output =
    document.createElement(
      'output'
    )

  output.className =
    'solar-setting-readonly'

  row.append(
    label,
    output
  )

  section.appendChild(
    row
  )

  const control = {
    refresh: () => {
      output.textContent =
        formatSettingNumber(
          getValue()
        )
    },
  }

  refreshableControls.push(
    control
  )

  control.refresh()
}

function createCheckboxControl(
  section: HTMLElement,
  labelText: string,
  tooltipText: string,
  getValue: () => boolean,
  setValue: (value: boolean) => void
) {
  const row =
    document.createElement(
      'label'
    )

  row.className =
    'solar-setting-row solar-setting-row-checkbox'

  const checkbox =
    document.createElement(
      'input'
    )

  checkbox.type =
    'checkbox'

  const label =
    document.createElement(
      'span'
    )

  label.textContent =
    labelText
  configureSettingLabel(
    label,
    tooltipText
  )

  checkbox.addEventListener(
    'change',
    () => {
      setValue(
        checkbox.checked
      )
    }
  )

  row.append(
    checkbox,
    label
  )

  section.appendChild(
    row
  )

  const control = {
    refresh: () => {
      checkbox.checked =
        getValue()
    },
  }

  refreshableControls.push(
    control
  )

  control.refresh()
}

const iconSection =
  createSettingsSection(
    'Per-body thresholds'
  )

createNumberControl(
  iconSection,
  'Icon fade out px',
  'Pixel diameter where this body starts switching from its icon to its physical sphere.',
  0,
  128,
  0.5,
  () =>
    getActiveBodySettings()
      .iconFadeOutPixelDiameter,
  (value) => {
    const settings =
      getMutableActiveBodySettings()

    settings.iconFadeOutPixelDiameter =
      value
    syncDerivedBodyTuningSettings(
      settings
    )
    refreshSettingsControls()
  }
)

createReadOnlyNumberControl(
  iconSection,
  'Icon fade in px',
  'Locked value derived from fade out. It gives the icon a small hysteresis gap so it does not flicker near the threshold.',
  () =>
    getActiveBodySettings()
      .iconFadeInPixelDiameter
)

createNumberControl(
  iconSection,
  'Orbit hide px',
  "Pixel diameter where this body's own orbit line hides as the body becomes large on screen.",
  0,
  256,
  0.5,
  () =>
    getActiveBodySettings()
      .orbitHidePixelDiameter,
  (value) => {
    getMutableActiveBodySettings()
      .orbitHidePixelDiameter =
      value
  }
)

createNumberControl(
  iconSection,
  'Local view px',
  'Pixel diameter that counts as a close local view around the tracked body for hiding distant clutter.',
  0,
  128,
  0.5,
  () =>
    getActiveBodySettings()
      .localViewPixelDiameter,
  (value) => {
    getMutableActiveBodySettings()
      .localViewPixelDiameter =
      value
  }
)

const gapSection =
  createSettingsSection(
    'Per-body orbit gaps'
  )

createNumberControl(
  gapSection,
  'Gap icon px',
  'Icon-size estimate used when cutting a gap in this body orbit line around the body marker.',
  0,
  96,
  0.5,
  () =>
    getActiveBodySettings()
      .orbitGapIconPixels,
  (value) => {
    getMutableActiveBodySettings()
      .orbitGapIconPixels =
      value
  }
)

createNumberControl(
  gapSection,
  'Gap min radius',
  'Smallest screen-space gap radius allowed around this body on its orbit line.',
  0,
  64,
  0.5,
  () =>
    getActiveBodySettings()
      .orbitGapMinRadius,
  (value) => {
    getMutableActiveBodySettings()
      .orbitGapMinRadius =
      value
  }
)

createNumberControl(
  gapSection,
  'Gap max radius',
  'Largest screen-space gap radius allowed around this body on its orbit line.',
  0,
  128,
  0.5,
  () =>
    getActiveBodySettings()
      .orbitGapMaxRadius,
  (value) => {
    getMutableActiveBodySettings()
      .orbitGapMaxRadius =
      value
  }
)

createNumberControl(
  gapSection,
  'Gap padding',
  'Extra pixels added around the body marker before its orbit line resumes.',
  0,
  64,
  0.5,
  () =>
    getActiveBodySettings()
      .orbitGapPadding,
  (value) => {
    getMutableActiveBodySettings()
      .orbitGapPadding =
      value
  }
)

const globalOrbitSection =
  createSettingsSection(
    'Global orbit lines'
  )

createCheckboxControl(
  globalOrbitSection,
  'Hide planet orbits in local view',
  'When viewing a body up close, hide unrelated planet orbit lines so the local system stays readable.',
  () =>
    orbitTuningSettings
      .hidePlanetOrbitsInTrackedLocalView,
  (value) => {
    orbitTuningSettings
      .hidePlanetOrbitsInTrackedLocalView =
      value
  }
)

createNumberControl(
  globalOrbitSection,
  'Gap alpha threshold',
  'Lowest projected gap strength that still cuts the orbit line.',
  0,
  1,
  0.01,
  () =>
    orbitTuningSettings
      .alphaGapThreshold,
  (value) => {
    orbitTuningSettings
      .alphaGapThreshold =
      value
  }
)

createNumberControl(
  globalOrbitSection,
  'Max segment ratio',
  'Maximum orbit segment length relative to the viewport before the overlay splits or skips it.',
  0.1,
  2,
  0.05,
  () =>
    orbitTuningSettings
      .maxSegmentLengthRatio,
  (value) => {
    orbitTuningSettings
      .maxSegmentLengthRatio =
      value
  }
)

createNumberControl(
  globalOrbitSection,
  'Planet orbit alpha',
  'Opacity for all planet orbit lines.',
  0,
  1,
  0.01,
  () =>
    orbitTuningSettings
      .planetOrbitAlpha,
  (value) => {
    orbitTuningSettings
      .planetOrbitAlpha =
      value
  }
)

createNumberControl(
  globalOrbitSection,
  'Planet orbit width',
  'Line width in pixels for all planet orbit lines.',
  0.25,
  5,
  0.25,
  () =>
    orbitTuningSettings
      .planetOrbitWidth,
  (value) => {
    orbitTuningSettings
      .planetOrbitWidth =
      value
  }
)

createNumberControl(
  globalOrbitSection,
  'Moon orbit alpha',
  'Opacity for all moon orbit lines.',
  0,
  1,
  0.01,
  () =>
    orbitTuningSettings
      .moonOrbitAlpha,
  (value) => {
    orbitTuningSettings
      .moonOrbitAlpha =
      value
  }
)

createNumberControl(
  globalOrbitSection,
  'Moon orbit width',
  'Line width in pixels for all moon orbit lines.',
  0.25,
  5,
  0.25,
  () =>
    orbitTuningSettings
      .moonOrbitWidth,
  (value) => {
    orbitTuningSettings
      .moonOrbitWidth =
      value
  }
)

const cameraSection =
  createSettingsSection(
    'Global camera'
  )

createNumberControl(
  cameraSection,
  'Axis close-up x radius',
  'Controls when the camera may stop orbiting around the body\'s orbital-plane axis. Set 0 to keep that axis locked at every range; a positive value releases the lock inside this many body radii. This is not a zoom limit.',
  0,
  30,
  0.25,
  () =>
    cameraTuningSettings
      .constrainedAxisCloseupRangeMultiplier,
  (value) => {
    cameraTuningSettings
      .constrainedAxisCloseupRangeMultiplier =
      value
  },
  {
    clamp: false,
  }
)

createNumberControl(
  cameraSection,
  'Surface zoom x radius',
  'Closest radial camera distance from the active body centre. 1 touches the surface; the default 1.55 stops at 0.55 body radii above it. Values below 1 permit close-up views inside the rendered sphere. The number box accepts any value; the slider is only a convenient range.',
  0,
  2,
  0.01,
  () =>
    cameraTuningSettings
      .surfaceZoomLimitMultiplier,
  (value) => {
    cameraTuningSettings
      .surfaceZoomLimitMultiplier =
      value
  },
  {
    clamp: false,
  }
)

createNumberControl(
  cameraSection,
  'Tracked zoom factor',
  'Multiplies each wheel or pinch zoom step while a body is centred. Cesium scales each step by the remaining distance to the surface limit, so higher values stay responsive nearer that limit; this cannot move through the limit set above.',
  0,
  20,
  0.25,
  () =>
    cameraTuningSettings
      .trackedBodyZoomFactor,
  (value) => {
    cameraTuningSettings
      .trackedBodyZoomFactor =
      value
  },
  {
    clamp: false,
  }
)

settingsPanel.append(
  settingsHeader,
  settingsTargetRow,
  settingsActions,
  settingsCopyStatus,
  settingsScopeNote,
  iconSection,
  gapSection,
  globalOrbitSection,
  cameraSection
)

const infoButton =
  document.createElement(
    'button'
  )

infoButton.type =
  'button'
infoButton.className =
  'solar-info-button'
infoButton.textContent =
  'Body info'
infoButton.title =
  'Show information about the selected body.'

const infoPanel =
  document.createElement(
    'section'
  )

infoPanel.className =
  'solar-info-panel'
infoPanel.hidden =
  true
infoPanel.setAttribute(
  'aria-label',
  'Selected body information'
)

const infoHeader =
  document.createElement(
    'div'
  )

infoHeader.className =
  'solar-info-header'

const infoTitle =
  document.createElement(
    'h2'
  )

infoTitle.textContent =
  'Body information'

const infoCloseButton =
  document.createElement(
    'button'
  )

infoCloseButton.type =
  'button'
infoCloseButton.textContent =
  'Close'

infoHeader.append(
  infoTitle,
  infoCloseButton
)

const infoList =
  document.createElement(
    'dl'
  )

infoList.className =
  'solar-info-list'

infoPanel.append(
  infoHeader,
  infoList
)

orbitOverlayParent.append(
  settingsButton,
  infoButton,
  settingsPanel,
  infoPanel
)

settingsButton.addEventListener(
  'click',
  () => {
    settingsPanel.hidden =
      !settingsPanel.hidden
    infoPanel.hidden =
      true
  }
)

settingsCloseButton.addEventListener(
  'click',
  () => {
    settingsPanel.hidden =
      true
  }
)

infoButton.addEventListener(
  'click',
  () => {
    infoPanel.hidden =
      !infoPanel.hidden
    settingsPanel.hidden =
      true
    updateSelectedBodyInfo()
  }
)

infoCloseButton.addEventListener(
  'click',
  () => {
    infoPanel.hidden =
      true
  }
)

settingsTargetSelect.addEventListener(
  'change',
  () => {
    activeSettingsTarget =
      getSettingsTargetById(
        settingsTargetSelect.value
      )

    refreshSettingsControls()
  }
)

settingsUseSelectedButton.addEventListener(
  'click',
  () => {
    const info =
      getBodyInfoForEntity(
        viewer.selectedEntity ??
          activeCameraTargetEntity
      )

    if (!info) {
      return
    }

    const targetId =
      `body:${info.name}`

    activeSettingsTarget =
      getSettingsTargetById(
        targetId
      )

    settingsTargetSelect.value =
      activeSettingsTarget.id

    refreshSettingsControls()
  }
)

settingsResetButton.addEventListener(
  'click',
  () => {
    if (
      activeSettingsTarget.bodyName
    ) {
      bodyTuningOverrides.delete(
        activeSettingsTarget.bodyName
      )
    } else {
      Object.assign(
        bodyTuningSettings[
          activeSettingsTarget.kind
        ],
        DEFAULT_BODY_TUNING_SETTINGS[
          activeSettingsTarget.kind
        ]
      )
    }

    refreshSettingsControls()
  }
)

settingsResetGlobalButton.addEventListener(
  'click',
  () => {
    Object.assign(
      orbitTuningSettings,
      DEFAULT_ORBIT_TUNING_SETTINGS
    )

    Object.assign(
      cameraTuningSettings,
      DEFAULT_CAMERA_TUNING_SETTINGS
    )

    refreshSettingsControls()
  }
)

settingsCopyButton.addEventListener(
  'click',
  () => {
    copyTextToClipboard(
      createSettingsDump()
    )
      .then(
        () => {
          showSettingsCopyStatus(
            'Copied settings dump'
          )
        }
      )
      .catch(
        () => {
          showSettingsCopyStatus(
            'Copy failed'
          )
        }
      )
  }
)


// --------------------------------------------------
// BODY TRACKING
// --------------------------------------------------

function getTrackableBodyAt(
  position: Cartesian2
) {
  const picked =
    viewer.scene.pick(
      position
    ) as
      | {
        id?: Entity
      }
      | undefined

  if (
    picked?.id &&
    trackableBodies.has(
      picked.id
    )
  ) {
    return picked.id
  }

  return undefined
}

function getDistanceToScreenSegment(
  point: Cartesian2,
  start: Cartesian2,
  end: Cartesian2
) {
  const deltaX =
    end.x - start.x
  const deltaY =
    end.y - start.y
  const lengthSquared =
    deltaX * deltaX +
    deltaY * deltaY

  if (lengthSquared === 0) {
    return Cartesian2.distance(
      point,
      start
    )
  }

  const progress =
    Math.max(
      0,
      Math.min(
        1,
        (
          (point.x - start.x) * deltaX +
          (point.y - start.y) * deltaY
        ) / lengthSquared
      )
    )

  return Math.hypot(
    point.x - (start.x + deltaX * progress),
    point.y - (start.y + deltaY * progress)
  )
}

function getOrbitEntityAt(
  position: Cartesian2
) {
  const candidates = [
    ...planetRenderData.map(
      (renderData) => ({
        entity: renderData.entity,
        positions: renderData.orbitPositions,
      })
    ),
    ...moonRenderData.map(
      (renderData) => ({
        entity: renderData.entity,
        positions: renderData.orbitPositions,
      })
    ),
  ]
  const maximumSegmentLength =
    Math.max(
      viewer.scene.canvas.clientWidth,
      viewer.scene.canvas.clientHeight
    ) *
    orbitTuningSettings
      .maxSegmentLengthRatio

  let closestEntity:
    | Entity
    | undefined
  let closestDistance =
    10

  for (const candidate of candidates) {
    const positions =
      candidate.positions.getValue(
        viewer.clock.currentTime
      ) as
        | Cartesian3[]
        | undefined

    if (!positions) {
      continue
    }

    for (
      let index = 1;
      index < positions.length;
      index += 1
    ) {
      const start =
        getScreenPosition(
          positions[index - 1]
        )
      const end =
        getScreenPosition(
          positions[index]
        )

      if (
        !start ||
        !end ||
        Cartesian2.distance(start, end) >
          maximumSegmentLength
      ) {
        continue
      }

      const distance =
        getDistanceToScreenSegment(
          position,
          start,
          end
        )

      if (distance < closestDistance) {
        closestDistance =
          distance
        closestEntity =
          candidate.entity
      }
    }
  }

  return closestEntity
}

function selectBody(
  entity: Entity
) {
  // Selection drives Cesium's green reticule. It intentionally does not alter
  // the camera target, which remains the body at the orbit centre.
  viewer.selectedEntity =
    entity
}

let activeCameraTargetEntity:
  | Entity
  | undefined

viewer.selectedEntityChanged.addEventListener(
  () => {
    updateSelectedBodyInfo()
  }
)

let cameraCentrePosition =
  Cartesian3.clone(
    sun_pos
  )

let redirectingNativeTracking =
  false

let activeControllerEllipsoid:
  | Ellipsoid
  | undefined

let activeControllerEllipsoidRadius =
  Number.NaN

function getEntityPosition(
  entity: Entity,
  result: Cartesian3 = new Cartesian3()
) {
  const physicalPosition =
    getEntityPhysicalPosition(
      entity
    )

  if (!physicalPosition) {
    return undefined
  }

  return toRenderPosition(
    physicalPosition,
    result
  )
}

function getEntityPhysicalPosition(
  entity: Entity
) {
  if (entity === sunEntity) {
    return sun_pos
  }

  const planet =
    planetRenderData.find(
      (renderData) =>
        renderData.entity === entity
    )

  if (planet) {
    return planet.physicalPosition
  }

  const moon =
    moonRenderData.find(
      (renderData) =>
        renderData.entity === entity
    )

  if (moon) {
    return moon.physicalPosition
  }

  return undefined
}

function getEntityRenderPosition(
  entity: Entity
) {
  if (entity === sunEntity) {
    return sunRenderPosition
  }

  const planet =
    planetRenderData.find(
      (renderData) =>
        renderData.entity === entity
    )

  if (planet) {
    return planet.currentPosition
  }

  const moon =
    moonRenderData.find(
      (renderData) =>
        renderData.entity === entity
    )

  if (moon) {
    return moon.currentPosition
  }

  return undefined
}

function getEntityRadius(
  entity: Entity
) {
  if (entity === sunEntity) {
    return sun_rad
  }

  const planet =
    planetRenderData.find(
      (renderData) =>
        renderData.entity === entity
    )

  if (planet) {
    return planet.planet.radius
  }

  const moon =
    moonRenderData.find(
      (renderData) =>
        renderData.entity === entity
    )

  if (moon) {
    return moon.moon.radius
  }

  return undefined
}

function isEntityMoon(
  entity:
    | Entity
    | undefined
) {
  if (!entity) {
    return false
  }

  return moonRenderData.some(
    (renderData) =>
      renderData.entity === entity
  )
}

function cloneBodyTuningSettings(
  settings: BodyTuningSettings
): BodyTuningSettings {
  return {
    ...settings,
  }
}

function getBodyTuningSettings(
  bodyName: string,
  bodyKind: BodyKind
) {
  return (
    bodyTuningOverrides.get(
      bodyName
    ) ??
    bodyTuningSettings[
      bodyKind
    ]
  )
}

function getBodyInfoForEntity(
  entity:
    | Entity
    | undefined
) {
  if (!entity) {
    return undefined
  }

  if (entity === sunEntity) {
    return {
      name: 'Sun',
      kind:
        'sun' as BodyKind,
    }
  }

  const planet =
    planetRenderData.find(
      (renderData) =>
        renderData.entity === entity
    )

  if (planet) {
    return {
      name:
        planet.planet.name,
      kind:
        'planet' as BodyKind,
    }
  }

  const moon =
    moonRenderData.find(
      (renderData) =>
        renderData.entity === entity
    )

  if (moon) {
    return {
      name:
        moon.moon.name,
      kind:
        'moon' as BodyKind,
    }
  }

  return undefined
}

function formatInfoDistance(
  metres: number
) {
  const kilometres =
    metres / 1000

  if (metres >= AU * 0.1) {
    return `${(metres / AU).toFixed(3)} AU`
  }

  return `${Math.round(kilometres).toLocaleString()} km`
}

function formatInfoPeriod(
  hours: number
) {
  const absoluteHours =
    Math.abs(hours)
  const direction =
    hours < 0
      ? ' retrograde'
      : ''

  if (absoluteHours >= 24 * 365) {
    return `${(absoluteHours / (24 * 365.25)).toFixed(2)} years${direction}`
  }

  if (absoluteHours >= 48) {
    return `${(absoluteHours / 24).toFixed(2)} days${direction}`
  }

  return `${absoluteHours.toFixed(2)} hours${direction}`
}

function appendInfoRow(
  label: string,
  value: string
) {
  const term =
    document.createElement(
      'dt'
    )
  const description =
    document.createElement(
      'dd'
    )

  term.textContent =
    label
  description.textContent =
    value

  infoList.append(
    term,
    description
  )
}

function updateSelectedBodyInfo() {
  infoList.replaceChildren()

  const selectedEntity =
    viewer.selectedEntity
  const selected =
    getBodyInfoForEntity(
      selectedEntity
    )
  const target =
    getBodyInfoForEntity(
      activeCameraTargetEntity
    )

  infoTitle.textContent =
    selected
      ? selected.name
      : 'Body information'

  appendInfoRow(
    'Selection',
    selected?.name ?? 'None'
  )
  appendInfoRow(
    'Camera target',
    target?.name ?? 'None'
  )

  if (!selectedEntity || !selected) {
    return
  }

  if (selectedEntity === sunEntity) {
    const spin =
      getBodySpin('Sun')

    appendInfoRow('Kind', 'Star')
    appendInfoRow(
      'Radius',
      formatInfoDistance(sun_rad)
    )
    appendInfoRow(
      'Rotation',
      spin
        ? formatInfoPeriod(
            spin.rotationPeriodHours
          )
        : 'Unknown'
    )

    return
  }

  const planet =
    planetRenderData.find(
      (renderData) =>
        renderData.entity === selectedEntity
    )

  if (planet) {
    const spin =
      getBodySpin(
        planet.planet.name
      )
    const orbitalPeriodDays =
      Math.sqrt(
        planet.planet.a.base ** 3
      ) * 365.25

    appendInfoRow('Kind', 'Planet')
    appendInfoRow(
      'Radius',
      formatInfoDistance(
        planet.planet.radius
      )
    )
    appendInfoRow(
      'Solar distance',
      `${planet.planet.a.base.toFixed(3)} AU`
    )
    appendInfoRow(
      'Orbital period',
      formatInfoPeriod(
        orbitalPeriodDays * 24
      )
    )
    appendInfoRow(
      'Eccentricity',
      planet.planet.e.base.toFixed(4)
    )
    appendInfoRow(
      'Inclination',
      `${planet.planet.i.base.toFixed(2)} deg`
    )
    appendInfoRow(
      'Rotation',
      spin
        ? formatInfoPeriod(
            spin.rotationPeriodHours
          )
        : 'Unknown'
    )
    appendInfoRow(
      'Axis tilt',
      spin
        ? `${spin.axialTiltDegrees.toFixed(2)} deg`
        : 'Unknown'
    )

    if (planet.planet.name === 'Pluto') {
      appendInfoRow(
        'Binary companion',
        'Charon, shared barycentre'
      )
    }

    return
  }

  const moon =
    moonRenderData.find(
      (renderData) =>
        renderData.entity === selectedEntity
    )

  if (!moon) {
    return
  }

  if (moon.moon.isArtificialSatellite) {
    appendInfoRow('Kind', 'Spacecraft')
    appendInfoRow(
      'Model span',
      '109 m'
    )
    appendInfoRow(
      'Orbit altitude',
      formatInfoDistance(
        moon.moon.orbitRadius -
        moon.parent.planet.radius
      )
    )
  } else {
    const spin =
      getBodySpin(
        moon.moon.name,
        moon.moon
      )

    appendInfoRow('Kind', 'Moon')
    appendInfoRow(
      'Parent',
      moon.parent.planet.name
    )
    appendInfoRow(
      'Radius',
      formatInfoDistance(
        moon.moon.radius
      )
    )
    appendInfoRow(
      'Orbit radius',
      formatInfoDistance(
        moon.moon.orbitRadius
      )
    )
    appendInfoRow(
      'Orbital period',
      formatInfoPeriod(
        moon.moon.orbitalPeriodDays * 24
      )
    )
    appendInfoRow(
      'Inclination',
      `${moon.moon.inclination.toFixed(2)} deg`
    )
    appendInfoRow(
      'Rotation',
      spin
        ? formatInfoPeriod(
            spin.rotationPeriodHours
          )
        : 'Unknown'
    )
  }
}

function getBodyTuningForEntity(
  entity:
    | Entity
    | undefined
) {
  const info =
    getBodyInfoForEntity(
      entity
    )

  if (!info) {
    return undefined
  }

  return getBodyTuningSettings(
    info.name,
    info.kind
  )
}

function getPlanetTuning(
  renderData: PlanetRenderData
) {
  return getBodyTuningSettings(
    renderData.planet.name,
    'planet'
  )
}

function getMoonTuning(
  renderData: MoonRenderData
) {
  return getBodyTuningSettings(
    renderData.moon.name,
    'moon'
  )
}

function updateRenderOriginForCameraTarget() {
  if (!activeCameraTargetEntity) {
    setRenderOrigin(
      sun_pos
    )

    return
  }

  const physicalPosition =
    getEntityPhysicalPosition(
      activeCameraTargetEntity
    )

  if (physicalPosition) {
    setRenderOrigin(
      physicalPosition
    )
  }
}

function updateRenderedBodyPositions(
  currentTime: JulianDate,
  updatePlanetOrbitShapes: boolean
) {
  const plutoCharonPositions =
    getPlutoCharonPhysicalPositions(
      currentTime
    )

  sunRenderPosition =
    toRenderPosition(
      sun_pos,
      sunRenderPosition
    )

  sunPositionProperty.setValue(
    sunRenderPosition
  )

  updateBodyPrimitiveTransform(
    sunBodyPrimitive,
    sunRenderPosition,
    getBodyRotationMatrix(
      'Sun',
      currentTime
    )
  )

  updateBodyDayNightMaterial(
    sunBodyPrimitive,
    sunRenderPosition
  )

  for (const renderData of planetRenderData) {
    renderData.currentPosition =
      toRenderPosition(
        renderData.physicalPosition,
        renderData.currentPosition
      )

    renderData.positionProperty.setValue(
      renderData.currentPosition
    )

    const rotation =
      getBodyRotationMatrix(
        renderData.planet.name,
        currentTime
      )

    updateBodyPrimitiveTransform(
      renderData.bodyPrimitive,
      renderData.currentPosition,
      rotation
    )

    if (
      renderData.planet.name === 'Saturn' &&
      saturnRingPrimitive
    ) {
      updateBodyPrimitiveTransform(
        saturnRingPrimitive,
        renderData.currentPosition,
        rotation
      )
    }

    updateBodyDayNightMaterial(
      renderData.bodyPrimitive,
      renderData.currentPosition
    )

    if (updatePlanetOrbitShapes) {
      renderData.physicalOrbitPositions =
        createOrbitPositions(
          renderData.planet,
          currentTime
        )
    }

    renderData.orbitPositions.setValue(
      toRenderPositions(
        renderData.physicalOrbitPositions
      )
    )
  }

  for (const renderData of moonRenderData) {
    renderData.currentPosition =
      toRenderPosition(
        renderData.physicalPosition,
        renderData.currentPosition
      )

    renderData.positionProperty.setValue(
      renderData.currentPosition
    )

    updateBodyPrimitiveTransform(
      renderData.bodyPrimitive,
      renderData.currentPosition,
      getBodyRotationMatrix(
        renderData.moon.name,
        currentTime,
        renderData.moon
      )
    )

    updateBodyDayNightMaterial(
      renderData.bodyPrimitive,
      renderData.currentPosition
    )

    renderData.orbitPositions.setValue(
      toRenderPositions(
        createMoonOrbitPositions(
          renderData.moon,
          renderData.moon.name === 'Charon' &&
          plutoCharonPositions
            ? plutoCharonPositions.barycentre
            : renderData.parent.physicalPosition,
          144,
          renderData.moon.name === 'Charon' &&
          plutoCharonPositions
            ? plutoCharonPositions.charonOrbitRadius
            : renderData.moon.orbitRadius
        )
      )
    )
  }
}

function refreshEntityDisplayNow(
  currentTime: JulianDate
) {
  viewer.dataSourceDisplay.update(
    currentTime
  )

  viewer.scene.requestRender()
}

function getCameraConstraintAxisWorld(
  _entity:
    | Entity
    | undefined
): Cartesian3 {
  // This scene uses the J2000 ecliptic plane as its common solar-system
  // reference. Keeping one axis prevents the camera frame from changing when
  // moving between planets, moons, and spacecraft.
  return Cartesian3.UNIT_Z
}

function getPerpendicularUnitVector(
  direction: Cartesian3,
  candidates: Cartesian3[]
) {
  const normalisedDirection =
    Cartesian3.normalize(
      direction,
      new Cartesian3()
    )

  for (const candidate of candidates) {
    const directionComponent =
      Cartesian3.multiplyByScalar(
        normalisedDirection,
        Cartesian3.dot(
          candidate,
          normalisedDirection
        ),
        new Cartesian3()
      )

    const perpendicular =
      Cartesian3.subtract(
        candidate,
        directionComponent,
        new Cartesian3()
      )

    if (Cartesian3.magnitude(perpendicular) >= 1e-7) {
      return Cartesian3.normalize(
        perpendicular,
        perpendicular
      )
    }
  }

  // This can only be reached for an invalid camera direction, but it keeps
  // the camera frame finite rather than letting a zero cross-product spread.
  return Cartesian3.clone(Cartesian3.UNIT_Y)
}

function getConstraintAlignedUp(
  directionWC: Cartesian3,
  constraintAxisWC: Cartesian3,
  fallbackUpWC: Cartesian3
) {
  return getPerpendicularUnitVector(
    directionWC,
    [
      constraintAxisWC,
      fallbackUpWC,
      Cartesian3.UNIT_Z,
      Cartesian3.UNIT_Y,
      Cartesian3.UNIT_X,
    ]
  )
}

function updateCameraConstraintAxis(
  entity:
    | Entity
    | undefined =
      activeCameraTargetEntity
) {
  const radius =
    entity
      ? getEntityRadius(
          entity
        )
      : undefined

  if (
    entity &&
    radius &&
    cameraTuningSettings
      .constrainedAxisCloseupRangeMultiplier > 0 &&
    Cartesian3.magnitude(
      viewer.camera.position
    ) <=
      radius *
        cameraTuningSettings
          .constrainedAxisCloseupRangeMultiplier
  ) {
    viewer.camera.constrainedAxis =
      undefined

    return
  }

  const localAxis =
    Matrix4.multiplyByPointAsVector(
      viewer.camera.inverseTransform,
      getCameraConstraintAxisWorld(
        entity
      ),
      new Cartesian3()
    )

  viewer.camera.constrainedAxis =
    Cartesian3.normalize(
      localAxis,
      localAxis
    )
}

function isEntityArtificialSatellite(
  entity:
    | Entity
    | undefined
) {
  if (!entity) {
    return false
  }

  return moonRenderData.some(
    (renderData) =>
      renderData.entity === entity &&
      renderData.moon.isArtificialSatellite
  )
}

function updateCameraControllerEllipsoid(
  radius:
    | number
    | undefined
) {
  if (!radius) {
    if (DEFAULT_CONTROLLER_ELLIPSOID) {
      cameraController._ellipsoid =
        DEFAULT_CONTROLLER_ELLIPSOID
    }

    cameraController.minimumPickingTerrainHeight =
      DEFAULT_MINIMUM_PICKING_TERRAIN_HEIGHT

    cameraController._minimumPickingTerrainHeight =
      DEFAULT_MINIMUM_PICKING_TERRAIN_HEIGHT

    cameraController.minimumPickingTerrainDistanceWithInertia =
      DEFAULT_MINIMUM_PICKING_TERRAIN_DISTANCE_WITH_INERTIA

    cameraController._minimumPickingTerrainDistanceWithInertia =
      DEFAULT_MINIMUM_PICKING_TERRAIN_DISTANCE_WITH_INERTIA

    cameraController.minimumCollisionTerrainHeight =
      DEFAULT_MINIMUM_COLLISION_TERRAIN_HEIGHT

    cameraController._minimumCollisionTerrainHeight =
      DEFAULT_MINIMUM_COLLISION_TERRAIN_HEIGHT

    cameraController.minimumTrackBallHeight =
      DEFAULT_MINIMUM_TRACK_BALL_HEIGHT

    cameraController._minimumTrackBallHeight =
      DEFAULT_MINIMUM_TRACK_BALL_HEIGHT

    activeControllerEllipsoidRadius =
      Number.NaN

    activeControllerEllipsoid =
      undefined

    return
  }

  if (
    radius !==
    activeControllerEllipsoidRadius
  ) {
    activeControllerEllipsoid =
      new Ellipsoid(
        radius,
        radius,
        radius
      )

    activeControllerEllipsoidRadius =
      radius
  }

  cameraController._ellipsoid =
    activeControllerEllipsoid

  const minimumPickingTerrainHeight =
    0

  const minimumPickingTerrainDistanceWithInertia =
    0

  const minimumCollisionTerrainHeight =
    0

  const minimumTrackBallHeight =
    0

  cameraController.minimumPickingTerrainHeight =
    minimumPickingTerrainHeight

  cameraController._minimumPickingTerrainHeight =
    minimumPickingTerrainHeight

  cameraController.minimumPickingTerrainDistanceWithInertia =
    minimumPickingTerrainDistanceWithInertia

  cameraController._minimumPickingTerrainDistanceWithInertia =
    minimumPickingTerrainDistanceWithInertia

  cameraController.minimumCollisionTerrainHeight =
    minimumCollisionTerrainHeight

  cameraController._minimumCollisionTerrainHeight =
    minimumCollisionTerrainHeight

  cameraController.minimumTrackBallHeight =
    minimumTrackBallHeight

  cameraController._minimumTrackBallHeight =
    minimumTrackBallHeight
}

function updateCameraZoomRate() {
  if (!activeCameraTargetEntity) {
    updateCameraControllerEllipsoid(
      undefined
    )

    cameraController.zoomFactor =
      DEFAULT_CAMERA_ZOOM_FACTOR

    cameraController._minimumZoomRate =
      DEFAULT_MINIMUM_ZOOM_RATE

    cameraController.minimumZoomDistance =
      DEFAULT_MINIMUM_ZOOM_DISTANCE

    cameraController.enableCollisionDetection =
      false

    cameraController._maximumZoomRate =
      100_000_000_000_000

    return
  }

  const radius =
    getEntityRadius(
      activeCameraTargetEntity
    )

  if (!radius) {
    return
  }

  if (
    isEntityArtificialSatellite(
      activeCameraTargetEntity
    )
  ) {
    // A 55 m proxy ellipsoid makes Cesium's collision camera alternate between
    // collision and inertia states. Spacecraft use an unconstrained controller
    // so they can be orbited and approached like a visible model.
    updateCameraControllerEllipsoid(
      undefined
    )

    cameraController.zoomFactor =
      Math.max(
        cameraTuningSettings
          .trackedBodyZoomFactor,
        40
      )
    cameraController.minimumZoomDistance =
      0.5
    cameraController.enableCollisionDetection =
      false
    cameraController._minimumZoomRate =
      0.05
    cameraController._maximumZoomRate =
      1_000_000

    return
  }

  updateCameraControllerEllipsoid(
    radius
  )

  cameraController.zoomFactor =
    cameraTuningSettings
      .trackedBodyZoomFactor

  cameraController.minimumZoomDistance =
    radius *
      (
        cameraTuningSettings
          .surfaceZoomLimitMultiplier -
        1
      )

  // Cesium only applies minimumZoomDistance as a hard stop when collision
  // handling is enabled. The custom ellipsoid above supplies that collision
  // surface without showing Cesium's normal Earth globe.
  cameraController.enableCollisionDetection =
    true

  cameraController._minimumZoomRate =
    Math.max(
      DEFAULT_MINIMUM_ZOOM_RATE,
      Math.min(
        radius * 0.5,
        1_000_000
      )
    )

  cameraController._maximumZoomRate =
    100_000_000_000_000
}

function normaliseCameraAxes() {
  Cartesian3.normalize(
    viewer.camera.direction,
    viewer.camera.direction
  )

  Cartesian3.clone(
    getPerpendicularUnitVector(
      viewer.camera.direction,
      [
        viewer.camera.up,
        Cartesian3.UNIT_Z,
        Cartesian3.UNIT_Y,
        Cartesian3.UNIT_X,
      ]
    ),
    viewer.camera.up
  )

  Cartesian3.cross(
    viewer.camera.direction,
    viewer.camera.up,
    viewer.camera.right
  )

  Cartesian3.normalize(
    viewer.camera.right,
    viewer.camera.right
  )

  Cartesian3.cross(
    viewer.camera.right,
    viewer.camera.direction,
    viewer.camera.up
  )

  Cartesian3.normalize(
    viewer.camera.up,
    viewer.camera.up
  )
}

function setCameraWorldStateForCentre(
  centre: Cartesian3,
  positionWC: Cartesian3,
  directionWC: Cartesian3,
  upWC: Cartesian3
) {
  const transform =
    Matrix4.fromTranslation(
      centre,
      new Matrix4()
    )

  const inverseTransform =
    Matrix4.inverseTransformation(
      transform,
      new Matrix4()
    )

  viewer.camera.lookAtTransform(
    transform
  )

  Matrix4.multiplyByPoint(
    inverseTransform,
    positionWC,
    viewer.camera.position
  )

  Matrix4.multiplyByPointAsVector(
    inverseTransform,
    directionWC,
    viewer.camera.direction
  )

  Matrix4.multiplyByPointAsVector(
    inverseTransform,
    upWC,
    viewer.camera.up
  )

  normaliseCameraAxes()
}

function setCameraCentrePreservingLocalState(
  centre: Cartesian3
) {
  const localPosition =
    Cartesian3.clone(
      viewer.camera.position
    )

  const localDirection =
    Cartesian3.clone(
      viewer.camera.direction
    )

  const localUp =
    Cartesian3.clone(
      viewer.camera.up
    )

  const transform =
    Matrix4.fromTranslation(
      centre,
      new Matrix4()
    )

  viewer.camera.lookAtTransform(
    transform
  )

  Cartesian3.clone(
    localPosition,
    viewer.camera.position
  )

  Cartesian3.clone(
    localDirection,
    viewer.camera.direction
  )

  Cartesian3.clone(
    localUp,
    viewer.camera.up
  )

  normaliseCameraAxes()
}

function updateCameraCentre() {
  if (!activeCameraTargetEntity) {
    return
  }

  const position =
    getEntityPosition(
      activeCameraTargetEntity
    )

  if (!position) {
    return
  }

  if (
    Cartesian3.distance(
      position,
      cameraCentrePosition
    ) < 1
  ) {
    updateCameraConstraintAxis()

    return
  }

  setCameraCentrePreservingLocalState(
    position
  )

  cameraCentrePosition =
    Cartesian3.clone(
      position,
      cameraCentrePosition
    )

  // The camera reference frame changes above, so resolve the axis after the
  // change rather than briefly applying it in the previous frame.
  updateCameraConstraintAxis()
}

function clearNativeTrackedEntity() {
  if (!viewer.trackedEntity) {
    return
  }

  redirectingNativeTracking =
    true

  viewer.trackedEntity =
    undefined

  redirectingNativeTracking =
    false
}

function trackBody(
  entity: Entity
) {
  const physicalPosition =
    getEntityPhysicalPosition(
      entity
    )

  if (!physicalPosition) {
    return
  }

  clearNativeTrackedEntity()

  const entityRadius =
    getEntityRadius(
      entity
    )

  const currentRange =
    Math.max(
      Cartesian3.distance(
        viewer.camera.positionWC,
        cameraCentrePosition
      ),
      1
    )

  if (
    isEntityArtificialSatellite(
      entity
    ) &&
    entityRadius
  ) {
    const satelliteRange =
      Math.max(
        450,
        getWholeBodyCameraRange(
          entityRadius
        ) * 3
      )

    if (currentRange > satelliteRange * 3) {
      frameBodyAtRange(
        entity,
        satelliteRange,
        viewer.camera.directionWC
      )

      return
    }
  }

  const range =
    currentRange

  const directionWC =
    Cartesian3.clone(
      viewer.camera.directionWC
    )

  const constraintAxisWC =
    getCameraConstraintAxisWorld(
      entity
    )

  const upWC =
    getConstraintAlignedUp(
      directionWC,
      constraintAxisWC,
      viewer.camera.upWC
    )

  activeCameraTargetEntity =
    entity

  setRenderOrigin(
    physicalPosition
  )

  updateRenderedBodyPositions(
    viewer.clock.currentTime,
    false
  )

  refreshEntityDisplayNow(
    viewer.clock.currentTime
  )

  const position =
    getEntityPosition(
      entity
    )

  if (!position) {
    return
  }

  const destination =
    Cartesian3.subtract(
      position,
      Cartesian3.multiplyByScalar(
        directionWC,
        range,
        new Cartesian3()
      ),
      new Cartesian3()
    )

  cameraCentrePosition =
    Cartesian3.clone(
      position,
      cameraCentrePosition
    )

  setCameraWorldStateForCentre(
    cameraCentrePosition,
    destination,
    directionWC,
    upWC
  )

  updateCameraConstraintAxis(
    entity
  )

  updateCameraZoomRate()

  updateSelectedBodyInfo()
}

function getWholeBodyCameraRange(
  radius: number
) {
  const frustum =
    viewer.camera.frustum

  const fovy =
    'fovy' in frustum &&
    typeof frustum.fovy ===
      'number'
      ? frustum.fovy
      : Math.PI / 3

  return (
    radius /
    Math.sin(
      fovy / 2
    ) *
    1.42
  )
}

function frameBodyAtRange(
  entity: Entity,
  range: number,
  directionWC: Cartesian3
) {
  const physicalPosition =
    getEntityPhysicalPosition(
      entity
    )

  if (!physicalPosition) {
    return false
  }

  clearNativeTrackedEntity()

  const normalisedDirectionWC =
    Cartesian3.normalize(
      directionWC,
      new Cartesian3()
    )

  const constraintAxisWC =
    getCameraConstraintAxisWorld(
      entity
    )

  const upWC =
    getConstraintAlignedUp(
      normalisedDirectionWC,
      constraintAxisWC,
      Cartesian3.UNIT_Z
    )

  activeCameraTargetEntity =
    entity

  setRenderOrigin(
    physicalPosition
  )

  updateRenderedBodyPositions(
    viewer.clock.currentTime,
    false
  )

  refreshEntityDisplayNow(
    viewer.clock.currentTime
  )

  const position =
    getEntityPosition(
      entity
    )

  if (!position) {
    return false
  }

  const destination =
    Cartesian3.subtract(
      position,
      Cartesian3.multiplyByScalar(
        normalisedDirectionWC,
        range,
        new Cartesian3()
      ),
      new Cartesian3()
    )

  cameraCentrePosition =
    Cartesian3.clone(
      position,
      cameraCentrePosition
    )

  setCameraWorldStateForCentre(
    cameraCentrePosition,
    destination,
    normalisedDirectionWC,
    upWC
  )

  updateCameraConstraintAxis(
    entity
  )

  updateCameraZoomRate()

  updateSelectedBodyInfo()

  return true
}

viewer
  .trackedEntityChanged
  .addEventListener(
    (
      entity:
        | Entity
        | undefined
    ) => {
      if (
        redirectingNativeTracking ||
        !entity ||
        !trackableBodies.has(
          entity
        )
      ) {
        return
      }

      redirectingNativeTracking =
        true

      viewer.trackedEntity =
        undefined

      redirectingNativeTracking =
        false

      trackBody(
        entity
      )
    }
  )

viewer
  .cesiumWidget
  .screenSpaceEventHandler
  .removeInputAction(
    ScreenSpaceEventType.LEFT_DOUBLE_CLICK
  )

viewer
  .cesiumWidget
  .screenSpaceEventHandler
  .setInputAction(
  (
    movement: {
      position: Cartesian2
    }
  ) => {
    const entity =
      getTrackableBodyAt(
        movement.position
      ) ??
      getOrbitEntityAt(
        movement.position
      )

    if (entity) {
      selectBody(
        entity
      )

      return
    }

    viewer.selectedEntity =
      undefined
  },
  ScreenSpaceEventType.LEFT_CLICK
)

viewer
  .cesiumWidget
  .screenSpaceEventHandler
  .setInputAction(
  (
    movement: {
      position: Cartesian2
    }
  ) => {
    const entity =
      getTrackableBodyAt(
        movement.position
      )

    if (entity) {
      selectBody(
        entity
      )
      trackBody(
        entity
      )
    }
  },
  ScreenSpaceEventType.LEFT_DOUBLE_CLICK
)

viewer.scene.canvas.addEventListener(
  'dblclick',
  (event) => {
    const bounds =
      viewer
        .scene
        .canvas
        .getBoundingClientRect()

    const entity =
      getTrackableBodyAt(
        new Cartesian2(
          event.clientX - bounds.left,
          event.clientY - bounds.top
        )
      )

    if (!entity) {
      return
    }

    event.preventDefault()
    event.stopImmediatePropagation()

    selectBody(
      entity
    )

    trackBody(
      entity
    )
  },
  true
)


// --------------------------------------------------
// ORBIT OVERLAY
// --------------------------------------------------

function prepareOrbitOverlay() {
  const width =
    orbitOverlayCanvas.clientWidth

  const height =
    orbitOverlayCanvas.clientHeight

  const dpr =
    window.devicePixelRatio ||
    1

  const bufferWidth =
    Math.max(
      1,
      Math.floor(
        width * dpr
      )
    )

  const bufferHeight =
    Math.max(
      1,
      Math.floor(
        height * dpr
      )
    )

  if (
    orbitOverlayCanvas.width !== bufferWidth ||
    orbitOverlayCanvas.height !== bufferHeight
  ) {
    orbitOverlayCanvas.width =
      bufferWidth

    orbitOverlayCanvas.height =
      bufferHeight
  }

  const context =
    orbitOverlayCanvas.getContext(
      '2d'
    )

  if (!context) {
    return undefined
  }

  context.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  )

  context.clearRect(
    0,
    0,
    width,
    height
  )

  return {
    context,
    width,
    height,
  }
}

function getScreenPosition(
  position: Cartesian3
) {
  const cameraToPosition =
    Cartesian3.subtract(
      position,
      viewer.camera.positionWC,
      new Cartesian3()
    )

  if (
    Cartesian3.dot(
      cameraToPosition,
      viewer.camera.directionWC
    ) <= 0
  ) {
    return undefined
  }

  return SceneTransforms
    .worldToWindowCoordinates(
      viewer.scene,
      position
    )
}

function getBodyPixelRadius(
  position: Cartesian3,
  radius: number
) {
  const edgePosition =
    Cartesian3.add(
      position,
      Cartesian3.multiplyByScalar(
        viewer.camera.rightWC,
        radius,
        new Cartesian3()
      ),
      new Cartesian3()
    )

  const edge =
    getScreenPosition(
      edgePosition
    )

  const centre =
    getScreenPosition(
      position
    )

  if (
    !centre ||
    !edge
  ) {
    return 0
  }

  return Cartesian2.distance(
    centre,
    edge
  )
}

function createOrbitGap(
  position: Cartesian3,
  radius: number,
  state: BillboardState,
  options: OrbitGapOptions
) {
  const centre =
    getScreenPosition(
      position
    )

  if (!centre) {
    return undefined
  }

  const bodyPixels =
    getBodyPixelRadius(
      position,
      radius
    )

  const iconBaseRadius =
    options.iconPixels / 2

  const iconRadius =
    (
      !state.suppressedByContext &&
      (
        state.visible ||
        state.alpha >
          orbitTuningSettings.alphaGapThreshold ||
        (
          state.hiddenBySize &&
          bodyPixels < iconBaseRadius
        )
      )
    )
      ? iconBaseRadius
      : 0

  const visibleRadius =
    Math.max(
      bodyPixels,
      iconRadius
    )

  if (
    visibleRadius <
    options.minRadius
  ) {
    return undefined
  }

  return {
    centre:
      Cartesian2.clone(
        centre
      ),

    radius:
      (
        bodyPixels >
        iconRadius
      )
        ? bodyPixels +
          options.padding
        : Math.min(
          options.maxRadius,
          visibleRadius +
          options.padding
        ),
  }
}

function getSegmentGapInterval(
  start: Cartesian2,
  end: Cartesian2,
  gap: OrbitGap
): SegmentInterval | undefined {
  const dx =
    end.x - start.x

  const dy =
    end.y - start.y

  const a =
    dx * dx +
    dy * dy

  if (a <= 0) {
    return undefined
  }

  const startX =
    start.x - gap.centre.x

  const startY =
    start.y - gap.centre.y

  const endX =
    end.x - gap.centre.x

  const endY =
    end.y - gap.centre.y

  const radiusSquared =
    gap.radius * gap.radius

  const startInside =
    (
      startX * startX +
      startY * startY
    ) <= radiusSquared

  const endInside =
    (
      endX * endX +
      endY * endY
    ) <= radiusSquared

  const b =
    2 *
    (
      startX * dx +
      startY * dy
    )

  const c =
    (
      startX * startX +
      startY * startY
    ) -
    radiusSquared

  const discriminant =
    b * b -
    4 * a * c

  if (discriminant < 0) {
    return startInside || endInside
      ? {
        start: 0,
        end: 1,
      }
      : undefined
  }

  const root =
    Math.sqrt(
      discriminant
    )

  const first =
    (
      -b -
      root
    ) /
    (
      2 * a
    )

  const second =
    (
      -b +
      root
    ) /
    (
      2 * a
    )

  if (
    second < 0 ||
    first > 1
  ) {
    return startInside && endInside
      ? {
        start: 0,
        end: 1,
      }
      : undefined
  }

  const intervalStart =
    Math.max(
      0,
      first
    )

  const intervalEnd =
    Math.min(
      1,
      second
    )

  if (
    intervalEnd <=
    intervalStart
  ) {
    return undefined
  }

  return {
    start:
      intervalStart,
    end:
      intervalEnd,
  }
}

function getVisibleSegmentIntervals(
  start: Cartesian2,
  end: Cartesian2,
  gaps: OrbitGap[]
) {
  if (gaps.length === 0) {
    return [
      {
        start: 0,
        end: 1,
      },
    ]
  }

  const gapIntervals =
    gaps
      .map(
        (gap) =>
          getSegmentGapInterval(
            start,
            end,
            gap
          )
      )
      .filter(
        (
          interval
        ): interval is SegmentInterval =>
          Boolean(
            interval
          )
      )
      .sort(
        (
          left,
          right
        ) =>
          left.start -
          right.start
      )

  if (gapIntervals.length === 0) {
    return [
      {
        start: 0,
        end: 1,
      },
    ]
  }

  const visibleIntervals:
    SegmentInterval[] = []

  let visibleStart =
    0

  for (const interval of gapIntervals) {
    if (
      interval.start >
      visibleStart
    ) {
      visibleIntervals.push({
        start:
          visibleStart,
        end:
          interval.start,
      })
    }

    visibleStart =
      Math.max(
        visibleStart,
        interval.end
      )

    if (visibleStart >= 1) {
      break
    }
  }

  if (visibleStart < 1) {
    visibleIntervals.push({
      start:
        visibleStart,
      end: 1,
    })
  }

  return visibleIntervals
}

function interpolateScreenPoint(
  start: Cartesian2,
  end: Cartesian2,
  amount: number
) {
  return new Cartesian2(
    start.x +
    (
      end.x - start.x
    ) *
    amount,
    start.y +
    (
      end.y - start.y
    ) *
    amount
  )
}

function isPointVisibleInFrontOfBody(
  point: Cartesian3,
  bodyPosition: Cartesian3,
  bodyRadius: number
) {
  const cameraToPoint =
    Cartesian3.subtract(
      point,
      viewer.camera.positionWC,
      new Cartesian3()
    )

  const pointDistance =
    Cartesian3.magnitude(
      cameraToPoint
    )

  if (pointDistance <= 0) {
    return false
  }

  const rayDirection =
    Cartesian3.divideByScalar(
      cameraToPoint,
      pointDistance,
      new Cartesian3()
    )

  const cameraToBody =
    Cartesian3.subtract(
      bodyPosition,
      viewer.camera.positionWC,
      new Cartesian3()
    )

  const bodyDistanceAlongRay =
    Cartesian3.dot(
      cameraToBody,
      rayDirection
    )

  if (
    bodyDistanceAlongRay <= 0 ||
    bodyDistanceAlongRay >= pointDistance
  ) {
    return true
  }

  const closestDistanceSquared =
    Cartesian3.magnitudeSquared(
      cameraToBody
    ) -
    bodyDistanceAlongRay *
      bodyDistanceAlongRay

  const bodyRadiusSquared =
    bodyRadius * bodyRadius

  if (
    closestDistanceSquared >=
    bodyRadiusSquared
  ) {
    return true
  }

  const nearSurfaceDistance =
    bodyDistanceAlongRay -
    Math.sqrt(
      bodyRadiusSquared -
        closestDistanceSquared
    )

  return pointDistance <= nearSurfaceDistance
}

function drawOrbitPath(
  context: CanvasRenderingContext2D,
  positions: Cartesian3[] | undefined,
  colour: string,
  alpha: number,
  width: number,
  gaps: OrbitGap[],
  canvasWidth: number,
  canvasHeight: number,
  isPointVisible: (
    (position: Cartesian3) => boolean
  ) | undefined = undefined
) {
  if (
    !positions ||
    positions.length < 2
  ) {
    return
  }

  const maxSegmentLength =
    Math.max(
      canvasWidth,
      canvasHeight
    ) *
    orbitTuningSettings
      .maxSegmentLengthRatio

  context.strokeStyle =
    colour
  context.globalAlpha =
    alpha
  context.lineWidth =
    width
  context.lineCap =
    'round'
  context.lineJoin =
    'round'

  let drawing =
    false

  let previousPoint:
    Cartesian2 |
    undefined

  const finishStroke =
    () => {
      if (drawing) {
        context.stroke()
        drawing =
          false
      }
    }

  for (const position of positions) {
    if (
      isPointVisible &&
      !isPointVisible(
        position
      )
    ) {
      finishStroke()
      previousPoint =
        undefined
      continue
    }

    const point =
      getScreenPosition(
        position
      )

    if (!point) {
      finishStroke()
      previousPoint =
        undefined
      continue
    }

    if (!previousPoint) {
      previousPoint =
        point
      continue
    }

    if (
      Cartesian2.distance(
        point,
        previousPoint
      ) > maxSegmentLength
    ) {
      finishStroke()
      previousPoint =
        point
      continue
    }

    const visibleIntervals =
      getVisibleSegmentIntervals(
        previousPoint,
        point,
        gaps
      )

    if (
      visibleIntervals.length === 0
    ) {
      finishStroke()
      previousPoint =
        point
      continue
    }

    for (
      let index = 0;
      index < visibleIntervals.length;
      index++
    ) {
      const interval =
        visibleIntervals[index]

      if (
        interval.end <=
        interval.start
      ) {
        continue
      }

      if (
        !drawing ||
        interval.start > 0 ||
        index > 0
      ) {
        finishStroke()

        const startPoint =
          interpolateScreenPoint(
            previousPoint,
            point,
            interval.start
          )

        context.beginPath()
        context.moveTo(
          startPoint.x,
          startPoint.y
        )
        drawing =
          true
      }

      const endPoint =
        interpolateScreenPoint(
          previousPoint,
          point,
          interval.end
        )

      context.lineTo(
        endPoint.x,
        endPoint.y
      )

      if (interval.end < 1) {
        finishStroke()
      }
    }

    previousPoint =
      point
  }

  finishStroke()

  context.globalAlpha =
    1
}

function createBodyOrbitGap(
  position: Cartesian3,
  radius: number,
  settings: BodyTuningSettings,
  state: BillboardState
) {
  return createOrbitGap(
    position,
    radius,
    state,
    {
      iconPixels:
        settings.orbitGapIconPixels,
      minRadius:
        settings.orbitGapMinRadius,
      maxRadius:
        settings.orbitGapMaxRadius,
      padding:
        settings.orbitGapPadding,
    }
  )
}

function shouldHideOrbitForBody(
  position: Cartesian3,
  radius: number,
  settings: BodyTuningSettings
) {
  return (
    settings.orbitHidePixelDiameter > 0 &&
    getPixelDiameter(
      position,
      radius
    ) >= settings.orbitHidePixelDiameter
  )
}

function drawOrbitOverlay() {
  const overlay =
    prepareOrbitOverlay()

  if (!overlay) {
    return
  }

  const hidePlanetOrbits =
    orbitTuningSettings
      .hidePlanetOrbitsInTrackedLocalView &&
    isTrackedBodyLocalView()

  const sunSettings =
    getBodyTuningSettings(
      'Sun',
      'sun'
    )

  const sunGap =
    createBodyOrbitGap(
      sunRenderPosition,
      sun_rad,
      sunSettings,
      sunBillboardState
    )

  if (!hidePlanetOrbits) {
    for (const renderData of planetRenderData) {
      const planetSettings =
        getPlanetTuning(
          renderData
        )

      const planetGap =
        createBodyOrbitGap(
          renderData.currentPosition,
          renderData.planet.radius,
          planetSettings,
          renderData.billboardState
        )

      const gaps =
        [
          sunGap,
          planetGap,
        ].filter(
          (
            gap
          ): gap is OrbitGap =>
            Boolean(
              gap
            )
        )

      drawOrbitPath(
        overlay.context,
        renderData.orbitPositions.getValue(
          viewer.clock.currentTime
        ) as Cartesian3[] | undefined,
        renderData.planet.colour,
        orbitTuningSettings.planetOrbitAlpha,
        orbitTuningSettings.planetOrbitWidth,
        gaps,
        overlay.width,
        overlay.height
      )
    }
  }

  const moonSystemGapsByParent =
    new Map<
      PlanetRenderData,
      OrbitGap[]
    >()

  const getMoonSystemGaps =
    (
      parent:
        PlanetRenderData
    ) => {
      const existingGaps =
        moonSystemGapsByParent.get(
          parent
        )

      if (existingGaps) {
        return existingGaps
      }

      const parentGap =
        createBodyOrbitGap(
          parent.currentPosition,
          parent.planet.radius,
          getPlanetTuning(
            parent
          ),
          parent.billboardState
        )

      const moonGaps =
        moonRenderData
          .filter(
            (renderData) =>
              renderData.parent === parent
          )
          .map(
            (renderData) =>
              createBodyOrbitGap(
                renderData.currentPosition,
                renderData.moon.radius,
                getMoonTuning(
                  renderData
                ),
                renderData.billboardState
              )
          )

      const gaps =
        [
          parentGap,
          ...moonGaps,
        ].filter(
          (
            gap
          ): gap is OrbitGap =>
            Boolean(
              gap
            )
        )

      moonSystemGapsByParent.set(
        parent,
        gaps
      )

      return gaps
    }

  for (const renderData of moonRenderData) {
    if (
      shouldHideOrbitForBody(
        renderData.currentPosition,
        renderData.moon.radius,
        getMoonTuning(
          renderData
        )
      )
    ) {
      continue
    }

    const isArtificialSatellite =
      Boolean(
        renderData.moon
          .isArtificialSatellite
      )

    const gaps =
      isArtificialSatellite
        ? [
          createBodyOrbitGap(
            renderData.currentPosition,
            renderData.moon.radius,
            getMoonTuning(
              renderData
            ),
            renderData.billboardState
          ),
        ].filter(
          (
            gap
          ): gap is OrbitGap =>
            Boolean(
              gap
            )
        )
        : getMoonSystemGaps(
          renderData.parent
        )

    drawOrbitPath(
      overlay.context,
      renderData.orbitPositions.getValue(
        viewer.clock.currentTime
      ) as Cartesian3[] | undefined,
      renderData.moon.colour,
      orbitTuningSettings.moonOrbitAlpha,
      orbitTuningSettings.moonOrbitWidth,
      gaps,
      overlay.width,
      overlay.height,
      isArtificialSatellite
        ? (position) =>
          isPointVisibleInFrontOfBody(
            position,
            renderData.parent
              .currentPosition,
            renderData.parent
              .planet.radius
          )
        : undefined
    )
  }
}


// --------------------------------------------------
// BILLBOARD FADE
// --------------------------------------------------

function moveBillboardAlphaToward(
  billboardColor: ConstantProperty,
  state: BillboardState,
  targetAlpha: number,
  deltaSeconds: number,
  fadeDuration: number
) {
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

function getPixelDiameter(
  position: Cartesian3,
  radius: number
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
    return 0
  }

  return (
    (
      angularDiameter /
      fovy
    ) *
    viewer.scene.canvas.clientHeight
  )
}

function getEarthTextureTierIndex(
  pixelDiameter: number
) {
  let tierIndex =
    activeEarthTextureTierIndex

  while (
    tierIndex <
      earthTextureTiers.length - 1 &&
    pixelDiameter >=
      earthTextureTiers[
        tierIndex + 1
      ].minimumPixelDiameter
  ) {
    tierIndex += 1
  }

  while (
    tierIndex > 0 &&
    pixelDiameter <
      earthTextureTiers[
        tierIndex
      ].downgradePixelDiameter
  ) {
    tierIndex -= 1
  }

  return tierIndex
}

function updateEarthTextureTier() {
  if (!earthRenderData) {
    return
  }

  const pixelDiameter =
    getPixelDiameter(
      earthRenderData.currentPosition,
      earthRenderData.planet.radius
    )

  const tierIndex =
    getEarthTextureTierIndex(
      pixelDiameter
    )

  if (
    tierIndex ===
    activeEarthTextureTierIndex
  ) {
    return
  }

  activeEarthTextureTierIndex =
    tierIndex

  setBodyPrimitiveTexture(
    earthRenderData.bodyPrimitive,
    earthTextureTiers[
      activeEarthTextureTierIndex
    ].image
  )

  viewer.scene.requestRender()
}

function updateBillboardFade(
  position: Cartesian3,
  radius: number,
  billboardColor: ConstantProperty,
  state: BillboardState,
  deltaSeconds: number,
  fadeOutThreshold: number = 16,
  fadeInThreshold: number = 15.5,
  fadeDuration: number = 0.4
) {
  const pixelDiameter =
    getPixelDiameter(
      position,
      radius
    )

  const wasSuppressedByContext =
    state.suppressedByContext

  state.suppressedByContext =
    false

  state.pixelDiameter =
    pixelDiameter


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

  // Local-view suppression deliberately does not change the size state. When
  // leaving that view, restore an icon immediately whenever it is back below
  // the fade-in threshold instead of waiting for another threshold crossing.
  if (
    wasSuppressedByContext &&
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

  state.hiddenBySize =
    !state.visible

  moveBillboardAlphaToward(
    billboardColor,
    state,
    targetAlpha,
    deltaSeconds,
    fadeDuration
  )
}

function updateMoonBillboardFade(
  position: Cartesian3,
  radius: number,
  billboardColor: ConstantProperty,
  state: BillboardState,
  parentBillboardState: BillboardState,
  parentIconSuppressed: boolean,
  settings: BodyTuningSettings,
  deltaSeconds: number
) {
  if (
    !parentIconSuppressed &&
    !parentBillboardState
      .suppressedByContext &&
    !parentBillboardState
      .hiddenBySize &&
    parentBillboardState.alpha > 0.05
  ) {
    state.visible = false
    state.hiddenBySize = false
    state.suppressedByContext = true
    state.pixelDiameter =
      getPixelDiameter(
        position,
        radius
      )

    moveBillboardAlphaToward(
      billboardColor,
      state,
      0,
      deltaSeconds,
      0.25
    )

    return
  }

  updateBillboardFade(
    position,
    radius,
    billboardColor,
    state,
    deltaSeconds,
    settings.iconFadeOutPixelDiameter,
    settings.iconFadeInPixelDiameter,
    0.25
  )
}

function isTrackedBodyLocalView() {
  const trackedEntity =
    activeCameraTargetEntity

  if (!trackedEntity) {
    return false
  }

  const position =
    getEntityRenderPosition(
      trackedEntity
    )

  const radius =
    getEntityRadius(
      trackedEntity
    )

  if (
    !position ||
    !radius
  ) {
    return false
  }

  return (
    getPixelDiameter(
      position,
      radius
    ) >=
    (
      getBodyTuningForEntity(
        trackedEntity
      ) ??
      bodyTuningSettings.planet
    ).localViewPixelDiameter
  )
}

function hideBillboardForLocalBodyView(
  billboardColor: ConstantProperty,
  state: BillboardState,
  deltaSeconds: number
) {
  state.suppressedByContext =
    true

  moveBillboardAlphaToward(
    billboardColor,
    state,
    0,
    deltaSeconds,
    0.2
  )
}

function hideAllBillboardsForLocalBodyView(
  deltaSeconds: number
) {
  if (!isTrackedBodyLocalView()) {
    return
  }

  hideBillboardForLocalBodyView(
    sunBillboardColor,
    sunBillboardState,
    deltaSeconds
  )

  for (const renderData of planetRenderData) {
    hideBillboardForLocalBodyView(
      renderData.billboardColor,
      renderData.billboardState,
      deltaSeconds
    )
  }

  const activePlanet =
    planetRenderData.find(
      (renderData) =>
        renderData.entity ===
        activeCameraTargetEntity
    )

  if (activePlanet) {
    for (const renderData of moonRenderData) {
      if (
        renderData.parent ===
        activePlanet
      ) {
        continue
      }

      hideBillboardForLocalBodyView(
        renderData.billboardColor,
        renderData.billboardState,
        deltaSeconds
      )
    }

    return
  }

  if (
    activeCameraTargetEntity !== sunEntity &&
    !isEntityMoon(
      activeCameraTargetEntity
    )
  ) {
    return
  }

  for (const renderData of moonRenderData) {
    hideBillboardForLocalBodyView(
      renderData.billboardColor,
      renderData.billboardState,
      deltaSeconds
    )
  }
}


// --------------------------------------------------
// UPDATE EVERYTHING EACH FRAME
// --------------------------------------------------

let previousFrameTime =
  performance.now()

let lastOrbitUpdateJulianDay =
  Number.NaN

viewer.scene.preUpdate.addEventListener(() => {
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


  let updatePlanetOrbitShapes =
    false

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

    updatePlanetOrbitShapes =
      true
  }


  // --------------------------------------------------
  // PHYSICAL POSITIONS
  // --------------------------------------------------

  const plutoCharonPositions =
    getPlutoCharonPhysicalPositions(
      currentTime
    )

  for (const renderData of planetRenderData) {
    renderData.physicalPosition =
      renderData.planet.name === 'Pluto' &&
      plutoCharonPositions
        ? plutoCharonPositions.pluto
        : getPlanetPosition(
            renderData.planet,
            currentTime
          )
  }

  for (const renderData of moonRenderData) {
    renderData.physicalPosition =
      renderData.moon.name === 'Charon' &&
      plutoCharonPositions
        ? plutoCharonPositions.charon
        : getMoonPosition(
            renderData.moon,
            renderData.parent.physicalPosition,
            currentTime
          )
  }

  updateRenderOriginForCameraTarget()

  updateRenderedBodyPositions(
    currentTime,
    updatePlanetOrbitShapes
  )

  refreshEntityDisplayNow(
    currentTime
  )


  // --------------------------------------------------
  // CAMERA CENTRE
  // --------------------------------------------------

  updateCameraCentre()

  updateCameraZoomRate()

  updateEarthTextureTier()


  // --------------------------------------------------
  // SUN
  // --------------------------------------------------

  const sunSettings =
    getBodyTuningSettings(
      'Sun',
      'sun'
    )

  updateBillboardFade(
    sunRenderPosition,
    sun_rad,
    sunBillboardColor,
    sunBillboardState,
    deltaSeconds,
    sunSettings.iconFadeOutPixelDiameter,
    sunSettings.iconFadeInPixelDiameter
  )


  // --------------------------------------------------
  // PLANETS
  // --------------------------------------------------

  for (const renderData of planetRenderData) {
    const planetSettings =
      getPlanetTuning(
        renderData
      )

    updateBillboardFade(
      renderData.currentPosition,
      renderData.planet.radius,
      renderData.billboardColor,
      renderData.billboardState,
      deltaSeconds,
      planetSettings.iconFadeOutPixelDiameter,
      planetSettings.iconFadeInPixelDiameter
    )
  }

  const parentIconsSuppressed =
    isTrackedBodyLocalView()


  // --------------------------------------------------
  // MOONS
  // --------------------------------------------------

  for (const renderData of moonRenderData) {
    updateMoonBillboardFade(
      renderData.currentPosition,
      renderData.moon.radius,
      renderData.billboardColor,
      renderData.billboardState,
      renderData.parent.billboardState,
      parentIconsSuppressed,
      getMoonTuning(
        renderData
      ),
      deltaSeconds
    )
  }


  // --------------------------------------------------
  // LOCAL BODY VIEW
  // --------------------------------------------------

  hideAllBillboardsForLocalBodyView(
    deltaSeconds
  )
})

viewer.scene.postRender.addEventListener(
  drawOrbitOverlay
)


// --------------------------------------------------
// INITIAL CAMERA
// --------------------------------------------------

const initialEarthCameraDirection =
  Cartesian3.normalize(
    new Cartesian3(
      -0.82,
      -0.34,
      -0.46
    ),
    new Cartesian3()
  )

const openedOnEarth =
  earthRenderData
    ? frameBodyAtRange(
        earthRenderData.entity,
        getWholeBodyCameraRange(
          earthRenderData.planet.radius
        ),
        initialEarthCameraDirection
      )
    : false

if (openedOnEarth) {
  updateEarthTextureTier()
} else {
  viewer.camera.lookAt(
    sun_pos,

    new HeadingPitchRange(
      0,
      -0.45,
      AU * 90
    )
  )
}

updateSelectedBodyInfo()
