<script setup>
// create a simple labeling app with paperjs
import { ref, onMounted, onUnmounted, onBeforeUnmount, watch } from 'vue'
import { showDirectoryPicker, showOpenFilePicker } from 'file-system-access'

import JSZip from 'jszip'
import paper from 'paper'

const state = ref('idle')
const currentSampleId = ref(null)
const canvas = ref(null)
const gui = ref(null)
const logger = ref(null)

var files = []
var labels = {}
var dataset = []

class Logger {
    constructor() {
        this.events = []
    }
    log(data) {
        this.events.push({
            timestamp: Date.now(),
            ...data
        })
    }
    download() {
        if (Object.keys(labels).length === 0) {
            return;
        }

        const blob = new Blob([JSON.stringify(this.events, null, 4)], { type: "application/json" });

        const zip = new JSZip();
        zip.file("metadata.json", blob);

        zip.generateAsync({ type: "blob" }).then((content) => {
            var url = URL.createObjectURL(content);
            var a = document.createElement("a");
            a.href = url;
            a.download = "metadata.zip";
            a.click();
        });
    }
}

class Gui {
    constructor() {
        paper.setup(canvas.value)
        paper.settings.handleSize = 10

        this.canvas = canvas.value
        this.view = paper.view
        this.project = paper.project
        this.paper = paper

        this.polys = []
        this.sceneImage = null
        this._tool = null

        this.listeners = {}
    }

    destroy() {
        this.disable()
        paper.remove()
    }

    enable() {
        this.on("click", this.onClick)
        this.on("mousemove", this.onMouseMove)
        this.on("mousewheel", this.onMouseWheel)
        this.on("resize", this.onResize)
        this.on("keydown", this.onKeyDown)
    }
    disable() {
        this.clearCallbacks()
    }

    /**
     * Set the callback for an event and remove any previous callbacks
     * @param {string} event - The event to set the callback for
     * @param {function} callback - The callback to set
     */
    on(event, callback) {
        this.clearCallbacks(event)

        callback = callback.bind(this)

        switch (event) {
            case 'click':
            case 'mousemove':
            case 'mousedown':
            case 'mouseup':
            case 'mousedrag':
                this.view.on(event, callback)
                var clear = () => this.view.off(event, callback)
                break
            case 'resize':
                this.canvas.parentElement.addEventListener(event, callback, { passive: false })
                var clear = () => this.canvas.parentElement.removeEventListener(event, callback)
                break
            default:
                document.addEventListener(event, callback, { passive: false })
                var clear = () => document.removeEventListener(event, callback)
        }

        if (!this.listeners[event]) {
            this.listeners[event] = []
        }

        this.listeners[event].push([callback, () => {
            this.listeners[event].splice(this.listeners[event].indexOf([callback, clear]), 1)
        }])

        return clear
    }

    /**
     * Remove all callbacks for an event
     * @param {string} event - The event to remove the callbacks for
     */
    clearCallbacks(event) {
        if (!event) {
            for (const event of Object.keys(this.listeners)) {
                this.clearCallbacks(event)
            }
            return
        }

        for (const [_, clear] of this.listeners[event] || []) {
            clear()
        }
    }

    set tool(tool) {
        if (tool)
            this.tools.label[tool]()
        else
            this.tools.label.clear()
        this._tool = tool
    }

    get tool() {
        return this._tool
    }

    objects = {
        list: new Set(), // list of all objects
        listFocus: new Set(), // list of all objects that are focused
        hasFocus: (target) => {
            return this.objects.listFocus.has(target)
        },
        Image: LabelImage,
        Polygon: {
            min_points: 1,
            num_points: -1,
            import: (object, options = {}) => {
                const points = object.points.map((point) => new paper.Point(point).multiply(this.sceneImage.bounds.size).add(this.sceneImage.bounds.topLeft))
                return this.objects.Polygon.new(points, options)
            },
            new: (points, options) => {
                points = points.slice()

                let defaults = {
                    segments: points,
                    strokeColor: "#00ff00",
                    closed: true,
                    visible: true,
                }

                let path = new paper.Path({ ...defaults, ...options })

                let handles = []

                for (let i = 0; i < path.segments.length; i++) {
                    const corner = new paper.Path.Circle({
                        center: path.segments[i].point,
                        radius: paper.settings.handleSize * 2,
                        visible: true,
                        fillColor: new paper.Color(0, 0, 0, 0.0001), // trick to make the handles clickable even if they are invisible
                    })

                    corner.handle_index = i

                    handles.push(corner)
                }

                const ret = {
                    type: "polygon",
                    focus: (value = true) => {
                        path.selected = value
                        if (value) {
                            path.bringToFront()
                            handles.forEach((corner) => corner.bringToFront())
                            this.objects.listFocus.add(ret)
                        } else {
                            this.objects.listFocus.delete(ret)
                        }
                    },
                    hasFocus: () => {
                        return this.objects.hasFocus(ret)
                    },
                    show: (value = true) => {
                        path.visible = value
                    },
                    enable: () => {
                        handles.forEach((corner) => corner.onClick = (e) => {
                            if (this.objects.listFocus.size > 0 && !ret.hasFocus())
                                return
                            e.stopPropagation()
                        })
                        handles.forEach((corner) => corner.onMouseEnter = (e) => {
                            if (this.objects.listFocus.size > 0 && !ret.hasFocus())
                                return
                            ret.focus()
                            e.stopPropagation()
                        })
                        handles.forEach((corner) => corner.onMouseLeave = (e) => {
                            console.log("unfocus")
                            ret.focus(false)
                        })
                        handles.forEach((corner) => corner.onMouseDrag = (e) => {
                            if (this.objects.listFocus.size > 0 && !ret.hasFocus())
                                return
                            logger.value.log({
                                "type": "drag",
                                "handle_index": corner.handle_index,
                                "shape": {
                                    "type": ret.type,
                                    "points": ret.points,
                                }
                            })
                            ret.updateCorner(handles.indexOf(corner), e)
                            ret.focus()
                            e.stopPropagation()
                        })
                        handles.forEach((corner) => corner.onMouseUp = (e) => {
                            logger.value.log({
                                "type": "up",
                                "handle_index": corner.handle_index,
                                "shape": {
                                    "type": ret.type,
                                    "points": ret.points,
                                }
                            })
                            ret.focus(false)
                        })
                        handles.forEach((corner) => corner.onMouseDown = (e) => {
                            logger.value.log({
                                "type": "down",
                                "handle_index": corner.handle_index,
                                "shape": {
                                    "type": ret.type,
                                    "points": ret.points,
                                }
                            })
                            ret.focus()
                        })
                        ret.show()
                    },
                    disable: () => {
                        handles.forEach((corner) => corner.onMouseEnter = null)
                        handles.forEach((corner) => corner.onMouseLeave = null)
                        handles.forEach((corner) => corner.onMouseDrag = null)
                    },
                    updateCorner: (i, e) => {
                        const points = ret.points.slice()

                        points[i] = e.point

                        ret.points = points
                    },
                    scale: (scale, origin) => {
                        path.scale(scale, origin)
                        handles.forEach((corner) => {
                            corner.position = corner.position.subtract(origin).multiply(scale).add(origin)
                        })
                    },
                    translate: (translation) => {
                        path.translate(translation)
                        handles.forEach((corner) => {
                            corner.position = corner.position.add(translation)
                        })
                    },
                    get points() {
                        return path.segments.map((segment) => segment.point)
                    },
                    set points(points) {
                        for (let i = 0; i < path.segments.length; i++) {
                            path.segments[i].point = points[i]
                            handles[i].position = points[i]
                        }
                    },
                    remove: () => {
                        handles.forEach((corner) => corner.remove())
                        path.remove()
                        ret.focus(false)
                    },
                    export: () => {
                        const points = ret.points
                            .map((point) => point.subtract(this.sceneImage.bounds.topLeft).divide(this.sceneImage.bounds.size))
                            .map((point) => [point.x, point.y])
                        return new LabelPolygon(points)
                    }
                }
                return ret
            }
        },
        Rectangle: {
            min_points: 1,
            num_points: 2,
            import: (object, options = {}) => {
                const points = object.points.map((point) => new paper.Point(point).multiply(this.sceneImage.bounds.size).add(this.sceneImage.bounds.topLeft))
                console.assert(points.length == this.objects.Rectangle.num_points)
                return this.objects.Rectangle.new(points, options)
            },
            new: (points, options) => {
                points = points.slice()

                if (points.length === 1) {
                    points.push(points[0].clone())
                }

                points = [points[0], new paper.Point(points[1].x, points[0].y), points[1], new paper.Point(points[0].x, points[1].y)]

                const ret = this.objects.Polygon.new(points, options)
                ret.type = "rectangle"
                ret.updateCorner = (i, e) => {
                    const points = ret.points.slice()

                    const corner = e.point
                    const opposite = points[(i + 2) % 4]

                    points[i] = corner
                    points[(i + 1) % 4] = new paper.Point(corner.x, opposite.y)
                    points[(i + 3) % 4] = new paper.Point(opposite.x, corner.y)

                    ret.points = points
                }
                ret.export = () => {
                    const points = ret.points
                        .map((point) => point.subtract(this.sceneImage.bounds.topLeft).divide(this.sceneImage.bounds.size))
                        .map((point) => [point.x, point.y])
                    return LabelBoundingBox.fromCorners(points[0], points[1])
                }
                return ret
            }
        },
        RotatedRectangle: {
            min_points: 1,
            num_points: 3,
            import: (object, options = {}) => {
                const points = object.points.map((point) => new paper.Point(point).multiply(this.sceneImage.bounds.size).add(this.sceneImage.bounds.topLeft))
                console.assert(points.length == this.objects.RotatedRectangle.num_points)
                return this.objects.RotatedRectangle.new(points, options)
            },
            new: (points, options) => {
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

                const ret = this.objects.Polygon.new(points, options)
                ret.type = "rotated_rectangle"
                ret.updateCorner = (i, e) => {
                    var points = ret.points.slice()

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

                    ret.points = points
                }
                ret.export = () => {
                    const points = ret.points
                        .map((point) => point.subtract(this.sceneImage.bounds.topLeft).divide(this.sceneImage.bounds.size))
                        .map((point) => [point.x, point.y])
                    return LabelRotatedBoundingBox.fromCorners(points[0], points[1], points[2])
                }
                return ret
            }
        }
    }

    tools = {
        label: {
            _tmp: {
                points: [],
                label: null,
            },
            callbacks: [],
            clear: () => {
                this.tools.label.callbacks.forEach((clear) => clear())
                this.tools.label.callbacks = []
                this.tools.label._tmp.points = []
                this.tools.label._tmp.label = null
            },
            new: (_class) => {
                this.tools.label.clear()
                this.tools.label.callbacks.push(
                    this.on("click", (e) => {
                        this.tools.label._tmp.points.push(e.point)
                        if (this.tools.label._tmp.label) {
                            this.tools.label._tmp.label.remove()
                        }

                        if (this.tools.label._tmp.points.length >= _class.min_points) {
                            this.tools.label._tmp.label = _class.new(this.tools.label._tmp.points)
                            this.tools.label._tmp.label.focus()
                        }

                        if (this.tools.label._tmp.points.length === _class.num_points) {
                            this.tools.label._tmp.label.focus(false)
                            this.tools.label._tmp.label.enable()
                            this.polys.push(this.tools.label._tmp.label)
                            this.tools.label._tmp.points = []
                            this.tools.label._tmp.label = null
                        }

                        e.preventDefault()
                    })
                )
                this.tools.label.callbacks.push(
                    this.on("mousemove", (e) => {
                        if (this.tools.label._tmp.label) {
                            this.tools.label._tmp.label.remove()
                        }
                        if (this.tools.label._tmp.points.length > 0 && this.tools.label._tmp.points.length + 1 >= _class.min_points) {
                            this.tools.label._tmp.label = _class.new([...this.tools.label._tmp.points, e.point], { selected: true })
                        }

                        e.preventDefault()
                    })
                )
            },
            BoundingBox: () => {
                this.tools.label.new(this.objects.Rectangle)
            },
            RotatedBoundingBox: () => {
                this.tools.label.new(this.objects.RotatedRectangle)
            },
            Polygon: () => {
                this.tools.label.new(this.objects.Polygon)
            },
        }
    }

    onClick(e) {
    }

    onMouseMove(e) {
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

    onKeyDown(e) {
        if (state.value !== 'running')
            return;

        switch (e.key) {
            case 'Escape':
                this.tool = null
                break;
            case 'ArrowLeft':
                state.value = 'loading'
                loadSample(Math.max(0, currentSampleId.value - 1)).then(() => {
                    state.value = 'running'
                })
                e.preventDefault()
                break;
            case 'ArrowRight':
                state.value = 'loading'
                loadSample(Math.min(dataset.length - 1, currentSampleId.value + 1)).then(() => {
                    state.value = 'running'
                })
                e.preventDefault()
                break;
        }
    }

    onResize(e) {
        const rect = this.paper.view.element.getBoundingClientRect()
        canvas.value.width = rect.width
        canvas.value.height = rect.height

        this.view.viewSize = new paper.Size(rect.width, rect.height)

        if (this.sceneImage === null)
            return

        const prevImageSize = this.sceneImage.bounds.size;
        const prevImagePos = this.sceneImage.position;

        // fit the image to the new view
        this.sceneImage.position = this.view.center;
        this.sceneImage.fitBounds(this.view.bounds);

        // get the scale and translation
        const scale = this.sceneImage.bounds.size.divide(prevImageSize);
        const translation = this.sceneImage.position.subtract(prevImagePos);

        // apply the scale and translation to the shapes
        for (let i = 0; i < this.polys.length; i++) {
            const shape = this.polys[i];

            shape.scale(scale, prevImagePos);
            shape.translate(translation);
        }
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
            items.forEach((item) => item.enable(visible))
        })
    }

    async add(d, visible = true) {
        const options = { visible: visible }

        let shape;
        switch (d.constructor) {
            case LabelImage:
                return this.setImage(d, visible)
            case LabelPolygon:
                shape = this.objects.Polygon.import(d, options)
                break;
            case LabelBoundingBox:
                shape = this.objects.Rectangle.import(d, options)
                break;
            case LabelRotatedBoundingBox:
                shape = this.objects.RotatedRectangle.import(d, options)
                break;

            default:
                throw new Error("Unsupported label type " + typeof d)
        }

        this.polys.push(shape)
        return shape
    }

    async setImage(d, visible = true) {
        this.sceneImage = null

        const raster = new this.paper.Raster({
            source: await d.getObjectURL(),
            visible: visible,
        });

        return new Promise((resolve, reject) => {
            raster.onLoad = resolve
            raster.onError = reject
        }).then(() => {
            this.sceneImage = raster
        }).then(
            this.onResize.bind(this)
        ).then(() => {
            return raster
        })
    }
}

class LabelImage {
    constructor(source, preload = false) {
        this._source = source
        this.loaded = false
        if (preload)
            this.load()
    }

    async getFileHandle() {
        await this.load()

        return this._file_handle
    }

    async getFile() {
        await this.load()

        return this._file
    }

    async getObjectURL() {
        await this.load()

        return this._obj_url
    }

    async load() {
        if (this.loaded)
            return

        if (this._source instanceof FileSystemFileHandle) {
            this._file_handle = this._source
            this._source = await this._source.getFile()
        }

        if (this._source instanceof File) {
            this._file = this._source
            this._obj_url = URL.createObjectURL(this._source)
        }

        this.loaded = true
    }
}

class LabelPolygon {
    constructor(points) {
        this.points = points
    }
}

class LabelBoundingBox extends LabelPolygon {
    constructor(cx, cy, w, h) {
        super([
            [cx - w / 2, cy - h / 2],
            // [cx + w / 2, cy - h / 2],
            [cx + w / 2, cy + h / 2],
            // [cx - w / 2, cy + h / 2],
        ])
    }


    static fromCorners(top_left, bottom_right) {
        new LabelBoundingBox([
            (top_left[0] + bottom_right[0]) / 2,
            (top_left[1] + bottom_right[1]) / 2,
            [bottom_right[0] - top_left[0]],
            [bottom_right[1] - top_left[1]],
        ])
    }

    getPoints() {
        return this.points
    }
}

class LabelRotatedBoundingBox extends LabelPolygon {

}



onMounted(() => {
    gui.value = new Gui()
    logger.value = new Logger()
})

onUnmounted(() => {
    gui.value.destroy()
    logger.value.destroy()
})

watch([state], () => {
    if (state.value === 'ready') {
        gui.value.enable()
        state.value = 'running'
        return () => {
            gui.destroy()
        }
    }
});

async function open() {
    showDirectoryPicker().then((handle) => {
        document.querySelector(".directory-picker").style.display = "none";

        const getFiles = async () => {
            var _files = [];
            for await (const entry of handle.values()) {
                if (entry.kind === "file") {
                    _files.push(entry);
                }
            }

            return _files;
        };

        return getFiles();
    }).then(async (_files) => {
        return DataLoader.YOLO.load(_files)
    }).then(() => {
        return loadSample(0);
    }).then(() => {
        state.value = 'ready';
    }).catch((err) => {
        if (err.name === "AbortError")
            return;

        throw err;
    })
}

const DataLoader = {
    YOLO: {
        allowedImageExtensions: ['jpg', 'jpeg', 'png'],
        async load(files) {
            const files_map = Object.fromEntries(Array.from(files).map((item) => [item.name, item]))

            await Promise.all(Object.entries(files_map).map(async ([full_name, file]) => {
                let [ext, ...name] = full_name.split('.').reverse()
                const sample_id = name.join("")

                if (!this.allowedImageExtensions.includes(ext.toLowerCase()))
                    return

                const sample = {
                    id: sample_id,
                    image: new LabelImage(file),
                    labels: []
                }
                if (`${name}.txt` in files_map) {
                    const str = await files_map[`${name}.txt`].getFile().then((f) => f.text())
                    for (const l of str.trim().split(/\r?\n/)) {
                        let points = l.split(" ").map((p) => Number(p))
                        points.shift() // Ignore class
                        sample.labels.push(new LabelBoundingBox(...points))
                    }
                }

                dataset.push(sample)
            }))
        }
    }
}

function loadSample(id) {
    if (id === null || id === currentSampleId.value) {
        return Promise.resolve();
    }

    if (currentSampleId.value !== null) {
        saveCurrentSample();
        gui.value.clear();
    }

    console.log(id, dataset)
    const sample = dataset[id]
    console.log(sample)

    return gui.value.add(sample.image)
        .then(() => {
            gui.value.addBatch(sample.labels)
        })
        .then(() => {
            currentSampleId.value = id;
        });
}

function saveCurrentSample() {
    if (currentSampleId.value === null) {
        return;
    }

    labels[currentSampleId.value] = gui.value.polys.map((poly) => {
        return poly.export();
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
        const name = dataset.name.split(".")[0] + ".txt";
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

function downloadAnnotationsJsonL(labels) {
    if (Object.keys(labels).length === 0) {
        return;
    }

    const zip = new JSZip();
    dataset.forEach((sample) => {
        const str = sample.labels.map((label) => JSON.stringify(label)).join("\n");
        const blob = new Blob([str], { type: "text/plain" })
        zip.file(sample.name + ".txt", blob);
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
    downloadAnnotationsJsonL(labels);
    logger.value.download()
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
        <div class="menu-item" :class="{ selected: gui.tool === 'BoundingBox' }"
            @click="gui.tool = (gui.tool === 'BoundingBox') ? null : 'BoundingBox'">
            <img src="/icons/bounding-box.svg" alt="New Bounding Box" />
        </div>
        <div class="menu-item" :class="{ selected: gui.tool === 'RotatedBoundingBox' }"
            @click="gui.tool = (gui.tool === 'RotatedBoundingBox') ? null : 'RotatedBoundingBox'">
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
