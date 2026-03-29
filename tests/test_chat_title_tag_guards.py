from pathlib import Path


def test_rename_modal_renders_chat_title_tag_toggle_row():
    template_source = Path("templates/app.html").read_text(encoding="utf-8")

    assert 'id="chat-title-tag-row"' in template_source
    assert 'data-chat-title-tag="none"' in template_source
    assert 'data-chat-title-tag="feat"' in template_source
    assert 'data-chat-title-tag="bug"' in template_source
    assert template_source.index('id="chat-title-tag-row"') < template_source.index('id="chat-title-input"')


def test_app_wires_chat_title_tag_selection_and_formatting_logic():
    app_source = Path("static/app.js").read_text(encoding="utf-8")
    admin_source = Path("static/chat_admin_helpers.js").read_text(encoding="utf-8")

    # Logic now lives in the chat-admin helper module.
    assert "const CHAT_TITLE_ALLOWED_TAGS = new Set(['none', 'feat', 'bug']);" in admin_source
    assert "function parseTaggedChatTitle(rawTitle)" in admin_source
    assert "function formatTaggedChatTitle(title, tag)" in admin_source
    assert "chatTitleTagRow.hidden = !showTagToggles" in admin_source
    assert "chatTitleTagButtons.forEach((button) => button.addEventListener('click', onTagSelect));" in admin_source
    assert "const formatted = showTagToggles ? formatTaggedChatTitle(value, chatTitleSelectedTag) : value;" in admin_source

    # app.js should wire UI nodes into chat admin controller.
    assert 'const chatTitleTagRow = document.getElementById("chat-title-tag-row");' in app_source
    assert 'const chatTitleTagButtons = Array.from(document.querySelectorAll("[data-chat-title-tag]"));' in app_source
    assert "const chatAdminController = chatAdminHelpers.createController({" in app_source
    assert "  chatTitleTagRow," in app_source
    assert "  chatTitleTagButtons," in app_source


def test_chat_title_tag_controls_have_css_hooks():
    css_source = Path("static/app.css").read_text(encoding="utf-8")

    assert ".chat-title-tags {" in css_source
    assert ".chat-title-tag {" in css_source
