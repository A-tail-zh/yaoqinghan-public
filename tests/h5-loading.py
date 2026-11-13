"""Run after building and starting the H5 preview. Uses only synthetic images and mocked API data."""
import copy
import struct
import sys
import zlib
from collections import Counter

from playwright.sync_api import expect, sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5188/'

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

pixel = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\x53\x63\x4d\xff')) + chunk(b'IEND', b'')
payload = {
    'firstPublishedAt': '2026-01-01T00:00:00Z', 'expiresAt': '2099-01-01T00:00:00Z',
    'content': {
        'invitation': {
            **{key: {'type': 'text', 'text': '活动邀请'} for key in ['brand', 'title', 'greeting', 'details']},
            **{key: f'/test-images/{key}.png' for key in ['backgroundImageUrl', 'leftDoorImageUrl', 'rightDoorImageUrl', 'sealImageUrl']},
        },
        'displayPages': [],
        'venue': {'title': '活动地点', 'name': '地点待公布', 'address': '地址待公布', 'imageUrl': None},
        'rsvp': {'title': '出席回执', 'nameLabel': '姓名', 'phoneLabel': '手机号', 'partySizeLabel': '出行人数', 'submitLabel': '提交'},
        'bgmUrl': '/test-music.mp3',
    },
}
payload['content']['invitation']['brand'] = {'type': 'image', 'imageUrl': '/test-images/brand.png', 'alt': '活动标识'}

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={'width': 390, 'height': 615})
    pending, errors, audio = [], [], []
    requested = Counter()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/api/public/invitation', lambda route: route.fulfill(json=payload))

    def hold_image(route):
        requested[route.request.url] += 1
        pending.append(route)

    page.route('**/test-images/*', hold_image)
    page.route('**/test-music.mp3', lambda route: (audio.append(route.request.url), route.abort()))
    page.goto(url, wait_until='domcontentloaded')
    expect(page.get_by_role('status')).to_contain_text('正在准备邀请函')
    expect(page.locator('.stage')).not_to_be_visible()
    for _ in range(50):
        if len(pending) == 5:
            break
        page.wait_for_timeout(100)
    assert len(pending) == 5, len(pending)
    for route in pending[:-1]:
        route.fulfill(content_type='image/png', body=pixel, headers={'Cache-Control': 'no-store'})
    page.wait_for_timeout(300)
    expect(page.locator('.stage')).not_to_be_visible()
    expect(page.locator('.wax')).not_to_be_visible()
    pending[-1].fulfill(content_type='image/png', body=pixel, headers={'Cache-Control': 'no-store'})
    expect(page.locator('.stage')).to_be_visible()
    assert page.locator('img').evaluate_all('(images) => images.every(image => image.complete && image.naturalWidth > 0)')
    assert all(count == 1 for count in requested.values()), requested
    assert not audio, 'Music must not compete with cover images before opening'
    assert page.evaluate('document.documentElement.scrollHeight <= innerHeight')
    assert not errors, errors
    page.close()

    page = browser.new_page(viewport={'width': 390, 'height': 615})
    broken = [True]
    without_music = copy.deepcopy(payload)
    without_music['content']['bgmUrl'] = None
    page.route('**/api/public/invitation', lambda route: route.fulfill(json=without_music))

    def image_response(route):
        if broken[0] and 'sealImageUrl' in route.request.url:
            route.fulfill(status=404, body='missing')
        else:
            route.fulfill(content_type='image/png', body=pixel)

    page.route('**/test-images/*', image_response)
    page.goto(url)
    expect(page.get_by_role('status')).to_contain_text('未加载完整')
    expect(page.locator('.stage')).not_to_be_visible()
    broken[0] = False
    page.get_by_role('button', name='重试').click()
    expect(page.locator('.stage')).to_be_visible()
    browser.close()
print('PASS: no partial cover, all images decoded before reveal, no duplicate image fetch or early music download, failed-image retry.')
