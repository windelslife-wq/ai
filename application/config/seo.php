<?php defined('BASEPATH') or exit('No direct script access allowed');

/** Environment-driven SEO settings; no server-specific values are committed. */
$seoBaseUrl = rtrim((string) (getenv('VP_BASE_URL') ?: ''), '/');
$seo['site_name'] = (string) (getenv('VP_SITE_NAME') ?: 'WINDELS AI WORKFORCE');
$seo['title_suffix'] = (string) (getenv('VP_SITE_TITLE_SUFFIX') ?: ' · WINDELS AI WORKFORCE');
$seo['description'] = (string) (getenv('VP_SITE_DESCRIPTION') ?: 'WINDELS AI WORKFORCE — a professional AI-powered platform for language learning, market analysis, sports research, lottery study and lead discovery. Evidence-first, audited and fail-closed.');
$seo['keywords'] = (string) (getenv('VP_SITE_KEYWORDS') ?: 'WINDELS AI Workforce, AI workforce, language learning, AI language teacher, trading intelligence, lead discovery, sports intelligence');
$seo['robots'] = (string) (getenv('VP_ROBOTS') ?: 'index,follow');
$seo['canonical'] = $seoBaseUrl !== '' ? $seoBaseUrl . '/' : '';
$seo['og_image'] = (string) (getenv('VP_OG_IMAGE') ?: (($seoBaseUrl !== '' ? $seoBaseUrl : '') . '/assets/images/windels-mark.png'));
$seo['theme_color'] = (string) (getenv('VP_THEME_COLOR') ?: '#07090e');
$config['settings'] = $seo;
