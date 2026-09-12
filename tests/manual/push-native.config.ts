import base from '../../playwright.config';
import {defineConfig} from '@playwright/test';
export default defineConfig({...base,testDir:'.',testMatch:'push-native.spec.ts'});
