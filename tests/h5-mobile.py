"""Run against a built H5 preview: python tests/h5-mobile.py [URL].

Requires Python Playwright and Microsoft Edge. API responses are mocked;
no activity data or real RSVP records are read or written.
"""
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5188/'
content = {
    'invitation': {
        **{key: {'type': 'text', 'text': text} for key, text in {
            'brand': '活动邀请', 'title': '邀请函',
            'greeting': '诚挚邀请您参加活动', 'details': '活动时间待公布',
        }.items()},
        **{key: None for key in ['backgroundImageUrl', 'leftDoorImageUrl', 'rightDoorImageUrl', 'sealImageUrl']},
    },
    'displayPages': [],
    'venue': {'title': '活动地点', 'name': '地点待公布', 'address': '地址待公布', 'imageUrl': None},
    'rsvp': {'title': '出席回执', 'nameLabel': '姓名', 'phoneLabel': '手机号', 'partySizeLabel': '出行人数', 'submitLabel': '提交'},
    'bgmUrl': None,
}
payload = {'firstPublishedAt': '2026-01-01T00:00:00Z', 'expiresAt': '2099-01-01T00:00:00Z', 'content': content}
output = Path(__file__).resolve().parents[1] / '.runtime'
output.mkdir(exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    for width, height in [(360, 640), (375, 667), (390, 844), (412, 760), (1440, 900)]:
        page = browser.new_page(viewport={'width': width, 'height': height}, reduced_motion='reduce')
        errors, submissions = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/api/public/invitation', lambda route: route.fulfill(json=payload))

        def submit(route):
            submissions.append({'body': route.request.post_data_json, 'key': route.request.headers['idempotency-key']})
            if len(submissions) == 1:
                route.fulfill(status=503, json={'error': {'message': '暂时无法保存，请重试'}})
            else:
                route.fulfill(status=201, json={'id': 'test-receipt'})

        page.route('**/api/public/invitation/rsvps', submit)
        page.goto(url)
        page.wait_for_load_state('networkidle')
        stage = page.locator('.stage')
        if width <= 600:
            box = stage.bounding_box()
            assert abs(box['x']) < 1 and abs(box['width'] - width) < 1, box
        page.locator('.open-cover').click()
        for _ in range(2):
            page.locator('.next-page').click()
        expect(page.locator('form.rsvp')).to_be_visible()
        page.evaluate("window.invalidEvents = 0; document.addEventListener('invalid', () => window.invalidEvents++, true)")
        button = page.locator('form.rsvp button[type=submit]')

        def invalid(field, value, message):
            page.locator(f'[name={field}]').fill(value)
            button.click()
            expect(page.locator('.field-error')).to_have_text(message)
            expect(page.locator(f'[name={field}]')).to_be_focused()
            expect(page.locator(f'[name={field}]')).to_have_attribute('aria-invalid', 'true')
            assert not submissions

        invalid('name', '', '请填写您的姓名')
        invalid('name', '   ', '请填写您的姓名')
        page.locator('[name=name]').fill(' 示例宾客 ')
        invalid('phone', '', '请填写您的手机号')
        for phone in ['abc123', '12345', '1-----', '123456789012345678901']:
            invalid('phone', phone, '请检查手机号是否填写正确')
        page.locator('[name=phone]').fill('+86 (138) 0000-0000')
        invalid('partySize', '', '请填写出行人数')
        for count in ['0', '-1', '1.5', '1e2', '4294967296']:
            invalid('partySize', count, '出行人数请填写有效的正整数')
        if width == 390:
            page.screenshot(path=str(output / 'mobile-inline-validation.png'), full_page=True)
        assert page.evaluate('window.invalidEvents') == 0
        before_width = stage.bounding_box()['width']
        page.set_viewport_size({'width': width, 'height': 380})
        assert abs(stage.bounding_box()['width'] - before_width) < 1
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        if width <= 600:
            page.set_viewport_size({'width': width + 20, 'height': height})
            assert abs(stage.bounding_box()['width'] - width - 20) < 1
        page.locator('[name=partySize]').fill('2')
        button.click()
        expect(page.locator('.submit-error')).to_have_text('暂时无法保存，请重试')
        expect(page.locator('[name=partySize]')).to_have_value('2')
        button.click()
        expect(page.get_by_role('dialog')).to_be_visible()
        assert len(submissions) == 2 and submissions[0] == submissions[1]
        assert submissions[0]['body']['name'] == '示例宾客'
        assert not errors, errors
        page.close()
    browser.close()
print('PASS: mobile edge-to-edge layout, viewport resize, inline validation, focus, no native bubbles, failed submit and idempotent retry.')
