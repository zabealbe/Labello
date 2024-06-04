<script setup>
// create a simple labeling app with paperjs
import { ref, onMounted, onUnmounted, onBeforeUnmount, watch } from 'vue'
import { showDirectoryPicker, showOpenFilePicker } from 'file-system-access'

import JSZip from 'jszip'
import paper from 'paper'
import { item } from '@unovis/ts/components/bullet-legend/style';

const allowedImageExtensions = ['jpg', 'jpeg', 'png']

const state = ref('idle')
const currentSampleId = ref(null)
const sceneShapes = ref([])
const sceneImage = ref(null)
const canvas = ref(null)
const gui = ref(null)

var files = []
var labels = {}

class Gui {
    constructor() {
        paper.setup(canvas.value)
        paper.settings.handleSize = 10

        this.view = paper.view
        this.project = paper.project
        this.paper = paper

        this.bufferPoints = []
        this.polys = []
        this.sceneImage = null
        this._tool = null

        this.enabled = false

        const call = (f) => {
            const c = (e) => {
                if (this.enabled)
                    f.call(this, e)
            }
            return c
        }

        this.onClick = call(this.onClick)
        this.onMouseMove = call(this.onMouseMove)
        this.onMouseWheel = call(this.onMouseWheel)
        this.onKeyDown = call(this.onKeyDown)

        this.view.onClick = this.onClick
        this.view.onMouseMove = this.onMouseMove
        document.addEventListener('wheel', this.onMouseWheel, { passive: false })
        document.addEventListener('keydown', this.onKeyDown, { passive: false })
    }

    destroy() {
        paper.remove()
        document.removeEventListener('wheel', this.onMouseWheel)
        document.removeEventListener('keydown', this.onKeyDown)
    }

    set tool(tool) {
        this.currentShape = null
        this.bufferPoints = []
        this._tool = tool
    }

    get tool() {
        return this._tool
    }

    onClick(e) {
        // check if there is already a shape being drawn
        if (this.project.selectedItems.length > 0 && !this.currentShape)
            return;

        // check if the selected tool is valid
        if (!this.tool)
            return;

        this.bufferPoints.push(e.point)

        if (this.currentShape) {
            this.currentShape.remove()
        }

        switch (this.tool) {
            case LabelRectangle.name:
                if (this.bufferPoints.length >= GuiRectangle.min_points) {
                    const object = new GuiRectangle(this.bufferPoints)
                    if (this.bufferPoints.length === GuiRectangle.num_points) {
                        this.polys.push(object)
                        this.bufferPoints = []
                    } else {
                        this.currentShape = object
                    }
                }
                break;
            case LabelRotatedRectangle.name:
                if (this.bufferPoints.length >= GuiRotatedRectangle.min_points) {
                    const object = new GuiRotatedRectangle(this.bufferPoints)
                    if (this.bufferPoints.length === GuiRotatedRectangle.num_points) {
                        this.polys.push(object)
                        this.bufferPoints = []
                    } else {
                        this.currentShape = object
                    }
                }
                break;
            case LabelPolygon.name:
                break;
            default:
                throw new Error("Unsupported tool " + this.tool)

        }
    }

    onMouseWheel(e) {
        if (!this.sceneImage)
            return;

        if (!e.ctrlKey)
            return;

        // Trackpad pinch-zoom
        const scale = Math.exp(-e.deltaY / 1000);

        // Dont allow zooming out if the image is too small
        if (this.sceneImage.bounds.width < 100 || this.sceneImage.bounds.height < 100 && scale < 1) {
            return;
        }

        const origin = this.view.viewToProject(paper.DomEvent.getOffset(e, canvas.value));

        this.sceneImage.scale(scale, origin);

        this.polys.forEach((shape) => {
            shape.scale(scale, origin);
        });

        e.preventDefault();
    }

    onMouseMove(e) {
        if (this.currentShape) {
            this.currentShape.remove()

            if (this.bufferPoints.length === 0) {
                return
            }

            const points = [...this.bufferPoints, e.point]
            const options = { selected: true }

            switch (this.tool) {
                case LabelRectangle.name:
                    if (points.length >= GuiRectangle.min_points) {
                        this.currentShape = new GuiRectangle(points, options)
                    }
                    break;
                case LabelRotatedRectangle.name:
                    if (points.length >= GuiRotatedRectangle.min_points) {
                        this.currentShape = new GuiRotatedRectangle(points, options)
                    }
                    break;
                case LabelPolygon.name:
                    break;
                default:
                    throw new Error("Unsupported tool " + this.tool)
            }

        }
    }

    onKeyDown(e) {
    }

    clear() {
        this.polys.forEach((shape) => shape.remove());
        this.polys = [];

        if (this.sceneImage) {
            this.sceneImage.remove();
            this.sceneImage = null;
        }
    }

    async addBatch(b, visible = true) {
        const promises = b.map((item) => this.add(item, false))

        return Promise.all(promises).then((items) => {
            const show = () => items.forEach((item) => item.show())
            const hide = () => items.forEach((item) => item.hide())

            if (visible)
                show()

            return {
                show: show,
                hide: hide,
            }
        })
    }

    async add(d, visible = true) {
        const options = { visible: visible }
        switch (d.constructor) {
            case LabelImage:
                return this.setImage(d.source, visible)
            case LabelRectangle:
                return this.polys.push(new GuiRectangle(d.points, options))
            case LabelRotatedRectangle:
                return this.polys.push(new GuiRotatedRectangle(d.points, options))
            case LabelPolygon:
                return this.polys.push(new GuiPolygon(d.points, options))
            default:
                throw new Error("Unsupported label type " + d.constructor.name)
        }
    }

    async setImage(d, visible = true) {
        this.sceneImage = null

        if (d instanceof FileSystemFileHandle)
            d = await d.getFile()

        if (d instanceof File)
            d = URL.createObjectURL(d)

        const raster = new paper.Raster({
            source: d,
            visible: false,
        });

        return new Promise((resolve, reject) => {
            raster.onLoad = resolve
            raster.onError = reject
        }).then(() => {
            raster.fitBounds(this.view.bounds)
            raster.position = this.view.center
            this.sceneImage = raster

            const show = () => {
                this.sceneImage.visible = true
            }
            const hide = () => {
                this.sceneImage.visible = false
            }

            if (visible)
                show()

            return {
                show: show,
                hide: hide,
            }
        })
    }
}

class GuiPolygon extends paper.Path {
    constructor(points, options = {}) {
        points = points.slice()
        var defaults = {
            segments: points,
            strokeColor: "#00ff00",
            closed: true,
            visible: true,
        }
        defaults = Object.assign(defaults, options)
        super(Object.assign(defaults, options))

        for (let i = 0; i < this.segments.length; i++) {
            const corner = new paper.Path.Circle({
                center: this.segments[i].point,
                radius: paper.settings.handleSize * 2,
                visible: true,
                fillColor: new paper.Color(0, 0, 0, 0.00001),
            })

            corner.onMouseEnter = () => this.selected = true
            corner.onMouseLeave = () => this.selected = false
            corner.onMouseDrag = (e) => {
                this.updateCorner(i, e)
            }

            this.addChild(corner)
        }
    }

    get points() {
        return this.segments.map((segment) => segment.point)
    }
    set points(points) {
        for (let i = 0; i < this.segments.length; i++) {
            this.segments[i].point = points[i]
        }
    }

    updateCorner(i, e) {
        this.points[i] = e.point
    }

    scale(scale, origin) {
        super.scale(scale, origin)
        this.handles.slice(1).forEach(corner => {
            corner.scale(1 / scale, corner.position)
        })
    }

    toLabel() {
        return new LabelPolygon(this.points)
    }
}

class GuiRectangle extends GuiPolygon {
    static min_points = 1
    static num_points = 2
    constructor(points, options = {}) {
        if (points.length < GuiRectangle.min_points)
            throw new Error("Not enough points to create a rectangle")

        points = points.slice()

        if (points.length === 1) {
            points.push(points[0].clone())
        }

        points = [points[0], new paper.Point(points[1].x, points[0].y), points[1], new paper.Point(points[0].x, points[1].y)]

        super(points, options)
    }

    updateCorner(i, e) {
        var points = this.points.slice()

        const corner = e.point
        const opposite = points[(i + 2) % 4]

        points[i] = corner
        points[(i + 1) % 4] = new paper.Point(corner.x, opposite.y)
        points[(i + 3) % 4] = new paper.Point(opposite.x, corner.y)

        this.points = points
    }

    toLabel() {
        return new LabelRectangle(this.points)
    }
}

class GuiRotatedRectangle extends GuiPolygon {
    static min_points = 1
    static num_points = 3
    constructor(points, options = {}) {
        if (points.length < GuiRotatedRectangle.min_points)
            throw new Error("Not enough points to create a rotated rectangle")

        points = points.slice()

        if (points.length === 1) {
            points.push(points[0].clone())
        }

        if (points.length === 2) {
            points.push(points[1].clone())
        }

        let s = points[1].subtract(points[0]).normalize();
        let t = new paper.Point(-s.y, s.x).normalize();

        let h = points[2].subtract(points[1]).dot(t)

        points[2] = points[1].add(t.multiply(h));

        // calculate fourth point to make it appear as a rotated bounding box
        points.push(points[2].add(points[0].subtract(points[1])));

        super(points, options)
    }

    updateCorner(i, e) {
        var points = this.points.slice()

        if (e.modifiers.control) {
            // if the control key is pressed rotate the shape around the opposite corner
            const center = points[(i + 2) % 4]
            const angle = e.point.subtract(center).angle - points[i].subtract(center).angle

            points = points.map(p => p.subtract(center).rotate(angle).add(center))
        } else {
            // otherwise keep the angle fixed and adjust the sides of the rectangle
            const opposite = points[(i + 2) % 4]

            const s1 = points[(i + 1) % 4].subtract(opposite).normalize()
            const s2 = points[(i + 3) % 4].subtract(opposite).normalize()

            // project the vector from the opposite corner to the current corner onto the sides of the rectangle
            const d = e.point.subtract(opposite)
            const d1 = d.dot(s1)
            const d2 = d.dot(s2)

            points[i] = e.point
            points[(i + 1) % 4] = opposite.add(s1.multiply(d1))
            points[(i + 3) % 4] = opposite.add(s2.multiply(d2))
        }

        this.points = points
    }

    toLabel() {
        return new LabelRotatedRectangle(this.points)
    }
}

class LabelImage {
    constructor(source) {
        this.source = source
    }
}

class LabelPolygon {
    constructor(points) {
        this.points = points
    }

    formatYolo() {
        return this.points.map(p => p.x + " " + p.y).join(" ")
    }
}

class LabelRectangle {
    constructor(points) {
        this.points = points
    }

    formatYolo() {
        const p1 = this.points[0]
        const p2 = this.points[1]

        const x = Math.min(p1.x, p2.x)
        const y = Math.min(p1.y, p2.y)
        const w = Math.abs(p1.x - p2.x)
        const h = Math.abs(p1.y - p2.y)

        return `0 ${x} ${y} ${w} ${h}`
    }
}

class LabelRotatedRectangle {
    constructor(points) {
        this.points = points
    }

    formatYolo() {
        const p1 = this.points[0]
        const p2 = this.points[1]
        const p3 = this.points[2]

        const s = p2.subtract(p1).normalize()
        const t = new paper.Point(-s.y, s.x).normalize()

        const h = p3.subtract(p2).dot(t)

        return `0 ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${h}`
    }
}


onMounted(() => {
    gui.value = new Gui()
})

onUnmounted(() => {
    gui.value.destroy()
})

watch([state], () => {
    if (state.value === 'ready') {
        gui.value.enabled = true
        // gui.value.view.onClick = onClick
        // gui.value.view.onMouseMove = onMouseMove
        // view.value.onResize = onResize

        // document.addEventListener('keydown', onKeyDown, { passive: false })
        // const resizeObserver = new ResizeObserver(onResize).observe(canvas.value.parentElement)

        state.value = 'running'

        return () => {
            gui.value.view.onClick = null
            gui.value.view.onMouseMove = null
            // view.value.onResize = null

            document.removeEventListener('keydown', onKeyDown)
            document.removeEventListener('wheel', onMouseWheel)

            // resizeObserver.disconnect()
        }
    }
});

function onResize() {
    const rect = canvas.value.parentElement.getBoundingClientRect()
    canvas.value.width = rect.widthprevImagePos
    canvas.value.height = rect.height

    gui.value.view.viewSize = new paper.Size(rect.width, rect.height)

    if (sceneImage.value === null)
        return

    const prevImageSize = sceneImage.value.bounds.size;
    const prevImagePos = sceneImage.value.position;

    // fit the image to the new view
    sceneImage.value.position = gui.value.view.center;
    sceneImage.value.fitBounds(gui.value.view.bounds);

    // get the scale and translation
    const scale = sceneImage.value.bounds.size.divide(prevImageSize);
    const translation = sceneImage.value.position.subtract(prevImagePos);

    // apply the scale and translation to the shapes
    for (let i = 0; i < sceneShapes.value.length; i++) {
        const shape = sceneShapes.value[i];

        shape.scale(scale, prevImagePos);
        shape.translate(translation);
    }
}

function onKeyDown(e) {
    if (state.value !== 'running')
        return;

    if (e.key === 'ArrowLeft') {
        state.value = 'loading'
        loadSample(Math.max(0, currentSampleId.value - 1)).then(() => {
            state.value = 'running'
        })
        e.preventDefault()
    } else if (e.key === 'ArrowRight') {
        state.value = 'loading'
        loadSample(Math.min(files.length - 1, currentSampleId.value + 1)).then(() => {
            state.value = 'running'
        })
        e.preventDefault()
    }
}

async function open() {
    showDirectoryPicker().then((handle) => {
        document.querySelector(".directory-picker").style.display = "none";

        const getFiles = async () => {
            var _files = [];
            for await (const entry of handle.values()) {
                if (entry.kind === "file" && allowedImageExtensions.includes(entry.name.split('.').pop())) {
                    _files.push(entry);
                }
            }

            return _files;
        };

        return getFiles();
    }).catch((err) => {
        if (err.name === "AbortError")
            return;

        throw err;
    }).then((_files) => {
        files = Array.from(_files);
    }).then(() => {
        return loadSample(0);
    }).then(() => {
        state.value = 'ready';
    });
}

function loadSample(id) {
    if (id === null || id === currentSampleId.value) {
        return Promise.resolve();
    }

    if (currentSampleId.value !== null) {
        saveCurrentSample();
        gui.value.clear();
    }

    return gui.value.addBatch([...(labels[files[id].name] || []), new LabelImage(files[id])]).then(() => {
        currentSampleId.value = id;
    });
}

function saveCurrentSample() {
    if (currentSampleId.value === null) {
        return;
    }

    labels[files[currentSampleId.value].name] = gui.value.polys.map((poly) => {
        return poly.toLabel();
    });
}

// download logic
function downloadAnnotationsYolo(labels) {
    if (Object.keys(labels).length === 0) {
        return;
    }

    const blobs = Object.keys(labels).map((scene) => {
        const str = labels[scene].map((label) => label.formatYolo()).join("\n");
        return new Blob([str], { type: "text/plain" });
    });

    const zip = new JSZip();
    blobs.forEach((blob, index) => {
        const name = files[index].name.split(".")[0] + ".txt";
        zip.file(name, blob);
    });

    zip.generateAsync({ type: "blob" }).then((content) => {
        var url = URL.createObjectURL(content);
        var a = document.createElement("a");
        a.href = url;
        a.download = "labels.zip";
        a.click();
    });
}

function downloadAnnotations() {
    saveCurrentSample();
    downloadAnnotationsYolo(labels);
}

</script>

<style scoped>
html,
body,
div#__next {
    height: 100%;
}

div#__next {
    display: flex;
    flex-direction: column;
}

.wrapper {
    flex-direction: row;
    flex: 1;
    overflow: hidden;
}

.directory-picker {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
}

.directory-picker button {
    background-color: #000;
    color: #fff;
    border: none;
    padding: 10px;
    cursor: pointer;
}

#paper-canvas-wrapper {
    flex: 1;
    overflow: scroll;
    display: flex;
}

#paper-canvas-wrapper::-webkit-scrollbar {
    display: none;
}

.selected {
    background-color: #000;
}
</style>

<template>
    <div class="menu-bar" v-if="state !== 'idle'">
        <div class="menu-item" :class="{ selected: gui.tool === 'LabelRectangle' }"
            @click="gui.tool = (gui.tool === LabelRectangle.name) ? '' : LabelRectangle.name">
            <img src="/icons/bounding-box.svg" alt="New Bounding Box" />
        </div>
        <div class="menu-item" :class="{ selected: gui.tool === 'LabelRotatedRectangle' }"
            @click="gui.tool = (gui.tool === LabelRotatedRectangle.name) ? '' : LabelRotatedRectangle.name">
            <img src="/icons/rotated-bounding-box.svg" alt="New Rotated Bounding Box" />
        </div>
        <div class="menu-item" @click="downloadAnnotations">
            <img src=" /icons/save.svg" alt="New Rotated Bounding Box" />
        </div>
    </div>
    <div id="paper-canvas-wrapper" class="wrapper">
        <canvas id="paper-canvas" resize="true" ref="canvas"></canvas>
    </div>
    <div class="directory-picker">
        <button @click="open">Open Directory</button>
    </div>
</template>
