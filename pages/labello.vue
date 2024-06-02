<script setup>
// create a simple labeling app with paperjs
import { ref, onMounted, onUnmounted, onBeforeUnmount, watch } from 'vue'
import { showDirectoryPicker, showOpenFilePicker } from 'file-system-access'

import JSZip from 'jszip'
import paper from 'paper'

const allowedImageExtensions = ['jpg', 'jpeg', 'png']

const state = ref('idle')
const selectedTool = ref(null)
const currentShape = ref(null)
const currentSampleId = ref(null)
const sceneShapes = ref([])
const sceneImage = ref(null)
var bufferPoints = []
const canvas = ref(null)
const view = ref(null)
const project = ref(null)
const tool = ref(null)
var files = []
var labels = {}

class Label extends paper.Group {
    constructor(children) {
        super([children])

        for (let i = 0; i < children.segments.length; i++) {
            const corner = new paper.Path.Circle({
                center: children.segments[i].point,
                radius: paper.settings.handleSize * 2,
                visible: true,
                fillColor: new paper.Color(0, 0, 0, 0.00001),
                insert: false,
            })

            corner.onMouseEnter = () => this.focus()
            corner.onMouseLeave = () => this.unfocus()
            corner.onMouseDrag = (e) => {
                this.updateCorner(i, e)
            }


            this.children.push(corner)
        }
    }

    updateHandles() {
        for (let i = 0; i < this.children[0].segments.length; i++) {
            this.children[i + 1].position = this.children[0].segments[i].point
        }
    }

    focus() {
        this.children[0].selected = true
    }
    unfocus() {
        this.children[0].selected = false
    }
    scale(scale, origin) {
        super.scale(scale, origin)
        this.children.slice(1).forEach(corner => {
            corner.scale(1 / scale, corner.position)
        })
    }
    remove() {
        this.children.forEach(corner => {
            corner.remove()
        })
        super.remove()
    }
}

class LabelRectangle extends Label {
    static min_points = 2
    static num_points = 2
    constructor(points) {
        const isComplete = points.length === LabelRectangle.num_points
        super(new paper.Path.Rectangle({
            from: points[0],
            to: points[1],
            strokeColor: "#00ff00",
        }))
        this.isComplete = isComplete
    }

    updateCorner(i, e) {
        const shape = this.children[0]

        const corner = e.point
        const opposite = shape.segments[(i + 2) % 4]

        shape.segments[i].point = corner
        shape.segments[(i + 1) % 4].point = new paper.Point(corner.x, opposite.point.y)
        shape.segments[(i + 3) % 4].point = new paper.Point(opposite.point.x, corner.y)

        this.updateHandles()
    }

    get points() {
        return [this.children[0].segments[0].point, this.children[0].segments[2].point]
    }
}

class LabelRotatedRectangle extends Label {
    static min_points = 2
    static num_points = 3
    constructor(points) {
        const isComplete = points.length === LabelRotatedRectangle.num_points
        if (points.length === 2) {
            points.push(points[1].clone())
        }

        let s = points[1].subtract(points[0]).normalize();
        let t = new paper.Point(-s.y, s.x).normalize();

        let h = 0
        if (points.length === 3) {
            h = points[2].subtract(points[1]).dot(t)
        }

        points[2] = points[1].add(t.multiply(h));

        // calculate fourth point to make it appear as a rotated bounding box
        const fourthPoint = points[2].add(points[0].subtract(points[1]));

        super(new paper.Path({
            segments: [points[0], points[1], points[2], fourthPoint],
            closed: true,
            strokeColor: "#00ff00",
        }))
        this.isComplete = isComplete
    }

    updateCorner(i, e) {
        const shape = this.children[0]

        if (e.modifiers.control) {
            // if the control key is pressed rotate the shape around the opposite corner
            const center = shape.segments[(i + 2) % 4].point
            const angle = e.point.subtract(center).angle - shape.segments[i].point.subtract(center).angle
            shape.rotate(angle, center)
        } else {
            // otherwise keep the angle fixed and adjust the sides of the rectangle
            const opposite = shape.segments[(i + 2) % 4]

            const s1 = shape.segments[(i + 1) % 4].point.subtract(opposite.point).normalize()
            const s2 = shape.segments[(i + 3) % 4].point.subtract(opposite.point).normalize()

            // project the vector from the opposite corner to the current corner onto the sides of the rectangle
            const d = e.point.subtract(opposite.point)
            const d1 = d.dot(s1)
            const d2 = d.dot(s2)

            shape.segments[i].point = e.point
            shape.segments[(i + 1) % 4].point = opposite.point.add(s1.multiply(d1))
            shape.segments[(i + 3) % 4].point = opposite.point.add(s2.multiply(d2))
        }

        this.updateHandles()
    }

    get points() {
        return [this.children[0].segments[0].point, this.children[0].segments[1].point, this.children[0].segments[2].point]
    }
}

class LabelPolygon extends Label {
    static min_points = 2
    static num_points = -1
    constructor(points) {
        const isComplete = points.length === LabelPolygon.num_points
        super(new paper.Path({
            segments: points,
            closed: true,
            strokeColor: "#00ff00",
        }))
        this.isComplete = isComplete
    }

    updateCorner(i, e) {
        const shape = this.children[0]

        shape.segments[i].point = e.point

        this.updateHandles()
    }

    get points() {
        return this.children[0].segments.map(s => s.point)
    }
}


onMounted(() => {
    paper.setup(canvas.value)
    paper.settings.handleSize = 10
    view.value = paper.view
    project.value = paper.project
})

onUnmounted(() => {
    paper.remove()
})

watch([state], () => {
    if (state.value === 'ready') {
        view.value.onClick = onClick
        view.value.onMouseMove = onMouseMove
        // view.value.onResize = onResize

        document.addEventListener('keydown', onKeyDown, { passive: false })
        document.addEventListener('wheel', onMouseWheel, { passive: false })
        const resizeObserver = new ResizeObserver(onResize).observe(canvas.value.parentElement)

        state.value = 'running'

        return () => {
            view.value.onClick = null
            view.value.onMouseMove = null
            // view.value.onResize = null

            document.removeEventListener('keydown', onKeyDown)
            document.removeEventListener('wheel', onMouseWheel)

            resizeObserver.disconnect()
        }
    }
});

function onResize() {
    const rect = canvas.value.parentElement.getBoundingClientRect()
    canvas.value.width = rect.widthprevImagePos
    canvas.value.height = rect.height

    view.value.viewSize = new paper.Size(rect.width, rect.height)

    if (sceneImage.value === null)
        return

    const prevImageSize = sceneImage.value.bounds.size;
    const prevImagePos = sceneImage.value.position;

    // fit the image to the new view
    sceneImage.value.position = view.value.center;
    sceneImage.value.fitBounds(view.value.bounds);

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

function onClick(e) {
    // check if there is already a shape being drawn
    if (project.value.selectedItems.length > 0 && !currentShape.value)
        return;

    // check if the selected tool is valid
    if (!selectedTool.value)
        return;

    // add the point to the buffer points
    bufferPoints.push(e.point);

    // check if the buffer points are enough to draw the shape
    if (currentShape.value && currentShape.value.isComplete) {
        currentShape.value.unfocus()

        // normalize the coordinates wrt the scene image
        for (let i = 0; i < bufferPoints.length; i++) {
            bufferPoints[i] = bufferPoints[i].subtract(sceneImage.value.bounds.topLeft).divide(sceneImage.value.bounds.size);
        }

        // add the shape to the scene shapes
        sceneShapes.value.push(currentShape.value);

        // clear
        bufferPoints = [];
        currentShape.value = null;
    }
}

function onMouseMove(e) {
    if (currentShape.value) {
        // update the current shape
        currentShape.value.remove()
        currentShape.value = null
    }
    if (selectedTool.value) {
        const points = bufferPoints.concat([e.point]);

        currentShape.value = drawShape(selectedTool.value, points, true);
    }
}

function onMouseWheel(e) {
    if (!e.ctrlKey)
        return;

    // Trackpad pinch-zoom
    const scale = Math.exp(-e.deltaY / 1000);

    // Dont allow zooming out if the image is too small
    if (sceneImage.value.bounds.width < 100 || sceneImage.value.bounds.height < 100 && scale < 1) {
        return;
    }

    const origin = view.value.viewToProject(paper.DomEvent.getOffset(e, canvas.value));

    sceneImage.value.scale(scale, origin);

    for (let i = 0; i < sceneShapes.value.length; i++) {
        const shape = sceneShapes.value[i];
        shape.scale(scale, origin);
    }

    e.preventDefault();
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
        URL.revokeObjectURL(sceneImage.value.source);
        sceneImage.value.remove();
        sceneImage.value = null;
        paper.project.clear();
        bufferPoints = [];
        sceneShapes.value = [];
    }

    // Load the image
    return files[id].getFile().then((file) => {
        sceneImage.value = new paper.Raster(URL.createObjectURL(file));

        return new Promise((resolve) => {
            sceneImage.value.onLoad = resolve;
        });
    }).then(() => {
        // Resize the image
        sceneImage.value.fitBounds(view.value.bounds);
        sceneImage.value.position = view.value.center;

        // Load the labels
        for (const l of labels[files[id].name] || []) {
            const points = l.points.map(p => p.multiply(sceneImage.value.bounds.size).add(sceneImage.value.bounds.topLeft));
            const shape = drawShape(l.type, points);
            sceneShapes.value.push(shape);
        }

        // Update the sample id
        currentSampleId.value = id;
    });
}

function saveCurrentSample() {
    if (currentSampleId.value === null) {
        return;
    }

    labels[files[currentSampleId.value].name] = sceneShapes.value.map((shape) => {
        return {
            type: shape.constructor.name,
            points: shape.points.map(p => p.subtract(sceneImage.value.bounds.topLeft).divide(sceneImage.value.bounds.size)),
        };
    });
}

// draw logic
function drawShape(type, points, preview = false) {
    const shapeClass = {
        [LabelRectangle.name]: LabelRectangle,
        [LabelRotatedRectangle.name]: LabelRotatedRectangle,
        [LabelPolygon.name]: LabelPolygon
    }[type];

    if (points.length < shapeClass.min_points)
        return;

    const shape = new shapeClass(points)

    if (preview)
        shape.focus()

    return shape
}

// download logic
function downloadAnnotationsYolo(labels) {
    if (Object.keys(labels).length === 0) {
        return;
    }

    const blobs = Object.keys(labels).map((scene) => {
        const shapes = labels[scene];
        const str = shapes.map((shape) => {
            const x = shape.points[0].x;
            const y = shape.points[0].y;
            const w = shape.points[1].x - shape.points[0].x;
            const h = shape.points[1].y - shape.points[0].y;
            return `0 ${x} ${y} ${w} ${h}\n`;
        }).join("");
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
        <div class="menu-item" :class="{ selected: selectedTool === 'LabelRectangle' }"
            @click="selectedTool = (selectedTool === LabelRectangle.name) ? '' : LabelRectangle.name">
            <img src="/icons/bounding-box.svg" alt="New Bounding Box" />
        </div>
        <div class="menu-item" :class="{ selected: selectedTool === 'LabelRotatedRectangle' }"
            @click="selectedTool = (selectedTool === LabelRotatedRectangle.name) ? '' : LabelRotatedRectangle.name">
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
