'use strict';

const MIN_BROWSER_EDGE_PX = 80;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeRect(value = {}) {
  const left = finiteNumber(value.left ?? value.x);
  const top = finiteNumber(value.top ?? value.y);
  const width = Math.max(0, finiteNumber(value.width));
  const height = Math.max(0, finiteNumber(value.height));
  const right = Number.isFinite(Number(value.right)) ? Number(value.right) : left + width;
  const bottom = Number.isFinite(Number(value.bottom)) ? Number(value.bottom) : top + height;
  return { left, top, right, bottom, width, height };
}

function viewportRect(value = {}) {
  const width = Math.max(0, finiteNumber(value.width));
  const height = Math.max(0, finiteNumber(value.height));
  return { left: 0, top: 0, right: width, bottom: height, width, height };
}

function intersectRects(firstValue, secondValue) {
  const first = normalizeRect(firstValue);
  const second = normalizeRect(secondValue);
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(0, Math.round(right - left)),
    height: Math.max(0, Math.round(bottom - top))
  };
}

function calculateBrowserDisplay(payload = {}, contentSize = {}, minimumEdge = MIN_BROWSER_EDGE_PX) {
  const rawDomRect = normalizeRect(payload.rawDomRect);
  const rendererViewport = viewportRect(payload.viewport);
  const windowViewport = viewportRect(contentSize);
  const usableViewport = intersectRects(rendererViewport, windowViewport);
  const visibleIntersection = intersectRects(rawDomRect, {
    left: usableViewport.x,
    top: usableViewport.y,
    width: usableViewport.width,
    height: usableViewport.height
  });
  let reason = 'visible';
  if (!payload.step3Active) reason = 'step3-inactive';
  else if (!payload.browserEnabled) reason = 'browser-disabled';
  else if (!rawDomRect.width || !rawDomRect.height) reason = 'slot-empty';
  else if (visibleIntersection.width < minimumEdge || visibleIntersection.height < minimumEdge) reason = 'slot-offscreen';
  const displayable = reason === 'visible';
  return {
    displayable,
    reason,
    rawDomRect,
    rendererViewport,
    windowViewport,
    visibleIntersection,
    appliedBounds: displayable ? visibleIntersection : { x: 0, y: 0, width: 0, height: 0 }
  };
}

function boundsIntersectContent(bounds = {}, contentSize = {}, minimumEdge = 1) {
  const intersection = intersectRects(normalizeRect(bounds), viewportRect(contentSize));
  return intersection.width >= minimumEdge && intersection.height >= minimumEdge;
}

module.exports = {
  MIN_BROWSER_EDGE_PX,
  normalizeRect,
  viewportRect,
  intersectRects,
  calculateBrowserDisplay,
  boundsIntersectContent
};
