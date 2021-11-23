/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

import * as zrUtil from 'zrender/src/core/util';
import { TextStyleProps } from 'zrender/src/graphic/Text';
import Displayable from 'zrender/src/graphic/Displayable';
import Element from 'zrender/src/Element';
import * as modelUtil from '../../util/model';
import * as graphicUtil from '../../util/graphic';
import * as layoutUtil from '../../util/layout';
import { parsePercent } from '../../util/number';
import GlobalModel from '../../model/Global';
import ComponentView from '../../view/Component';
import ExtensionAPI from '../../core/ExtensionAPI';
import { getECData } from '../../util/innerStore';
import { isEC4CompatibleStyle, convertFromEC4CompatibleStyle } from '../../util/styleCompat';
import {
    ElementMap,
    GraphicComponentModel,
    GraphicComponentDisplayableOption,
    GraphicComponentZRPathOption,
    GraphicComponentGroupOption,
    GraphicComponentElementOption
} from './GraphicModel';
import {
    applyLeaveTransition,
    applyUpdateTransition,
    isTransitionAll,
    updateLeaveTo
} from '../../animation/customGraphicTransition';
import { updateProps } from '../../animation/basicTrasition';
import { applyKeyframeAnimation } from '../../animation/customGraphicKeyframeAnimation';

const nonShapeGraphicElements = {
    // Reserved but not supported in graphic component.
    path: null as unknown,
    compoundPath: null as unknown,

    // Supported in graphic component.
    group: graphicUtil.Group,
    image: graphicUtil.Image,
    text: graphicUtil.Text
} as const;
type NonShapeGraphicElementType = keyof typeof nonShapeGraphicElements;

export const inner = modelUtil.makeInner<{
    widthOption: number;
    heightOption: number;
    width: number;
    height: number;
    isNew: boolean;
    id: string;
}, Element>();
// ------------------------
// View
// ------------------------
export class GraphicComponentView extends ComponentView {

    static type = 'graphic';
    type = GraphicComponentView.type;

    private _elMap: ElementMap;
    private _lastGraphicModel: GraphicComponentModel;

    init() {
        this._elMap = zrUtil.createHashMap();
    }

    render(graphicModel: GraphicComponentModel, ecModel: GlobalModel, api: ExtensionAPI): void {
        // Having leveraged between use cases and algorithm complexity, a very
        // simple layout mechanism is used:
        // The size(width/height) can be determined by itself or its parent (not
        // implemented yet), but can not by its children. (Top-down travel)
        // The location(x/y) can be determined by the bounding rect of itself
        // (can including its descendants or not) and the size of its parent.
        // (Bottom-up travel)

        // When `chart.clear()` or `chart.setOption({...}, true)` with the same id,
        // view will be reused.
        if (graphicModel !== this._lastGraphicModel) {
            this._clear();
        }
        this._lastGraphicModel = graphicModel;

        this._updateElements(graphicModel);
        this._relocate(graphicModel, api);
    }

    /**
     * Update graphic elements.
     */
    private _updateElements(graphicModel: GraphicComponentModel): void {
        const elOptionsToUpdate = graphicModel.useElOptionsToUpdate();

        if (!elOptionsToUpdate) {
            return;
        }

        const elMap = this._elMap;
        const rootGroup = this.group;

        const globalZ = graphicModel.get('z');
        const globalZLevel = graphicModel.get('zlevel');

        // Top-down tranverse to assign graphic settings to each elements.
        zrUtil.each(elOptionsToUpdate, function (elOption) {
            const id = modelUtil.convertOptionIdName(elOption.id, null);
            const elExisting = id != null ? elMap.get(id) : null;
            const parentId = modelUtil.convertOptionIdName(elOption.parentId, null);
            const targetElParent = (parentId != null ? elMap.get(parentId) : rootGroup) as graphicUtil.Group;

            const elType = elOption.type;
            const elOptionStyle = (elOption as GraphicComponentDisplayableOption).style;
            if (elType === 'text' && elOptionStyle) {
                // In top/bottom mode, textVerticalAlign should not be used, which cause
                // inaccurately locating.
                if (elOption.hv && elOption.hv[1]) {
                    (elOptionStyle as any).textVerticalAlign =
                        (elOptionStyle as any).textBaseline =
                        (elOptionStyle as TextStyleProps).verticalAlign =
                        (elOptionStyle as TextStyleProps).align = null;
                }
            }

            let textContentOption = (elOption as GraphicComponentZRPathOption).textContent;
            let textConfig = (elOption as GraphicComponentZRPathOption).textConfig;
            if (elOptionStyle
                && isEC4CompatibleStyle(elOptionStyle, elType, !!textConfig, !!textContentOption)) {
                const convertResult =
                    convertFromEC4CompatibleStyle(elOptionStyle, elType, true) as GraphicComponentZRPathOption;
                if (!textConfig && convertResult.textConfig) {
                    textConfig = (elOption as GraphicComponentZRPathOption).textConfig = convertResult.textConfig;
                }
                if (!textContentOption && convertResult.textContent) {
                    textContentOption = convertResult.textContent;
                }
            }

            // Remove unnecessary props to avoid potential problems.
            const elOptionCleaned = getCleanedElOption(elOption);

            // For simple, do not support parent change, otherwise reorder is needed.
            if (__DEV__) {
                elExisting && zrUtil.assert(
                    targetElParent === elExisting.parent,
                    'Changing parent is not supported.'
                );
            }

            const $action = elOption.$action || 'merge';
            if ($action === 'merge') {
                const isInit = !elExisting;
                let el = elExisting;
                if (isInit) {
                    el = createEl(id, targetElParent, elOption.type, elMap);
                }
                else {
                    el && (inner(el).isNew = false);
                }
                if (el) {
                    applyUpdateTransition(
                        el,
                        elOptionCleaned,
                        graphicModel,
                        { isInit }
                    );
                    updateZ(el, elOption, globalZ, globalZLevel);
                }
            }
            else if ($action === 'replace') {
                removeEl(elExisting, elMap, graphicModel);
                const el = createEl(id, targetElParent, elOption.type, elMap);
                if (el) {
                    applyUpdateTransition(
                        el,
                        elOptionCleaned,
                        graphicModel,
                        { isInit: true}
                    );
                    updateZ(el, elOption, globalZ, globalZLevel);
                }
            }
            else if ($action === 'remove') {
                updateLeaveTo(elExisting, elOption);
                removeEl(elExisting, elMap, graphicModel);
            }

            const el = elMap.get(id);

            if (el && textContentOption) {
                if ($action === 'merge') {
                    const textContentExisting = el.getTextContent();
                    textContentExisting
                        ? textContentExisting.attr(textContentOption)
                        : el.setTextContent(new graphicUtil.Text(textContentOption));
                }
                else if ($action === 'replace') {
                    el.setTextContent(new graphicUtil.Text(textContentOption));
                }
            }

            if (el) {
                const elInner = inner(el);
                elInner.widthOption = (elOption as GraphicComponentGroupOption).width;
                elInner.heightOption = (elOption as GraphicComponentGroupOption).height;
                setEventData(el, graphicModel, elOption);

                graphicUtil.setTooltipConfig({
                    el: el,
                    componentModel: graphicModel,
                    itemName: el.name,
                    itemTooltipOption: elOption.tooltip
                });

                if (elOption.animation) {
                    applyKeyframeAnimation(el, elOption.animation);
                }
            }
        });
    }

    /**
     * Locate graphic elements.
     */
    private _relocate(graphicModel: GraphicComponentModel, api: ExtensionAPI): void {
        const elOptions = graphicModel.option.elements;
        const rootGroup = this.group;
        const elMap = this._elMap;
        const apiWidth = api.getWidth();
        const apiHeight = api.getHeight();

        const xy = ['x', 'y'] as const;

        // Top-down to calculate percentage width/height of group
        for (let i = 0; i < elOptions.length; i++) {
            const elOption = elOptions[i];
            const id = modelUtil.convertOptionIdName(elOption.id, null);
            const el = id != null ? elMap.get(id) : null;

            if (!el || !el.isGroup) {
                continue;
            }
            const parentEl = el.parent;
            const isParentRoot = parentEl === rootGroup;
            // Like 'position:absolut' in css, default 0.
            const elInner = inner(el);
            const parentElInner = inner(parentEl);
            elInner.width = parsePercent(
                elInner.widthOption,
                isParentRoot ? apiWidth : parentElInner.width
            ) || 0;
            elInner.height = parsePercent(
                elInner.heightOption,
                isParentRoot ? apiHeight : parentElInner.height
            ) || 0;
        }

        // Bottom-up tranvese all elements (consider ec resize) to locate elements.
        for (let i = elOptions.length - 1; i >= 0; i--) {
            const elOption = elOptions[i];
            const id = modelUtil.convertOptionIdName(elOption.id, null);
            const el = id != null ? elMap.get(id) : null;

            if (!el) {
                continue;
            }

            const parentEl = el.parent;
            const parentElInner = inner(parentEl);
            const containerInfo = parentEl === rootGroup
                ? {
                    width: apiWidth,
                    height: apiHeight
                }
                : {
                    width: parentElInner.width,
                    height: parentElInner.height
                };



            // PENDING
            // Currently, when `bounding: 'all'`, the union bounding rect of the group
            // does not include the rect of [0, 0, group.width, group.height], which
            // is probably weird for users. Should we make a break change for it?
            const layoutPos = {} as Record<'x' | 'y', number>;
            const layouted = layoutUtil.positionElement(
                el, elOption, containerInfo, null,
                { hv: elOption.hv, boundingMode: elOption.bounding },
                layoutPos
            );

            if (!inner(el).isNew && layouted) {
                const transition = elOption.transition;
                const animatePos = {} as Record<'x' | 'y', number>;
                for (let k = 0; k < xy.length; k++) {
                    const key = xy[k];
                    const val = layoutPos[key];
                    if (transition && (isTransitionAll(transition) || zrUtil.indexOf(transition, key) >= 0)) {
                        animatePos[key] = val;
                    }
                    else {
                        el[key] = val;
                    }
                }
                updateProps(el, animatePos, graphicModel, 0);
            }
            else {
                el.attr(layoutPos);
            }
        }
    }

    /**
     * Clear all elements.
     */
    private _clear(): void {
        const elMap = this._elMap;
        elMap.each((el) => {
            removeEl(el, elMap, this._lastGraphicModel);
        });
        this._elMap = zrUtil.createHashMap();
    }

    dispose(): void {
        this._clear();
    }
}
function createEl(
    id: string,
    targetElParent: graphicUtil.Group,
    graphicType: string,
    elMap: ElementMap
): Element {

    if (__DEV__) {
        zrUtil.assert(graphicType, 'graphic type MUST be set');
    }

    const Clz = (
        zrUtil.hasOwn(nonShapeGraphicElements, graphicType)
            // Those graphic elements are not shapes. They should not be
            // overwritten by users, so do them first.
            ? nonShapeGraphicElements[graphicType as NonShapeGraphicElementType]
            : graphicUtil.getShapeClass(graphicType)
    ) as { new(opt: GraphicComponentElementOption): Element; };

    if (__DEV__) {
        zrUtil.assert(Clz, 'graphic type can not be found');
    }

    const el = new Clz({});
    targetElParent.add(el);
    elMap.set(id, el);
    inner(el).id = id;
    inner(el).isNew = true;

    return el;
}
function removeEl(elExisting: Element, elMap: ElementMap, graphicModel: GraphicComponentModel): void {
    const existElParent = elExisting && elExisting.parent;
    if (existElParent) {
        elExisting.type === 'group' && elExisting.traverse(function (el) {
            removeEl(el, elMap, graphicModel);
        });
        applyLeaveTransition(elExisting, graphicModel);
        elMap.removeKey(inner(elExisting).id);
    }
}

function updateZ(el: Element, elOption: GraphicComponentElementOption, defaultZ: number, defaultZlevel: number) {
    if (el.isGroup) {
        return;
    }

    const elDisplayable = el as Displayable;
    // We should not support configure z and zlevel in the element level.
    // But seems we didn't limit it previously. So here still use it to avoid breaking.
    elDisplayable.z = zrUtil.retrieve2((elOption as any).z, defaultZ);
    elDisplayable.zlevel = zrUtil.retrieve2((elOption as any).zlevel, defaultZlevel);
    // z2 must not be null/undefined, otherwise sort error may occur.
    const optZ2 = (elOption as GraphicComponentDisplayableOption).z2;
    optZ2 != null && (elDisplayable.z2 = optZ2 || 0);

}
// Remove unnecessary props to avoid potential problems.
function getCleanedElOption(
    elOption: GraphicComponentElementOption
): Omit<GraphicComponentElementOption, 'textContent'> {
    elOption = zrUtil.extend({}, elOption);
    zrUtil.each(
        ['id', 'parentId', '$action', 'hv', 'bounding', 'textContent'].concat(layoutUtil.LOCATION_PARAMS),
        function (name) {
            delete (elOption as any)[name];
        }
    );
    return elOption;
}

function setEventData(
    el: Element,
    graphicModel: GraphicComponentModel,
    elOption: GraphicComponentElementOption
): void {
    let eventData = getECData(el).eventData;
    // Simple optimize for large amount of elements that no need event.
    if (!el.silent && !el.ignore && !eventData) {
        eventData = getECData(el).eventData = {
            componentType: 'graphic',
            componentIndex: graphicModel.componentIndex,
            name: el.name
        };
    }

    // `elOption.info` enables user to mount some info on
    // elements and use them in event handlers.
    if (eventData) {
        eventData.info = elOption.info;
    }
}
