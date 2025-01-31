/* global APP $ */

import { multiremotebrowser } from '@wdio/globals';
import { Key } from 'webdriverio';

import { IConfig } from '../../react/features/base/config/configType';
import { urlObjectToString } from '../../react/features/base/util/uri';
import BreakoutRooms from '../pageobjects/BreakoutRooms';
import ChatPanel from '../pageobjects/ChatPanel';
import Filmstrip from '../pageobjects/Filmstrip';
import IframeAPI from '../pageobjects/IframeAPI';
import InviteDialog from '../pageobjects/InviteDialog';
import LobbyScreen from '../pageobjects/LobbyScreen';
import Notifications from '../pageobjects/Notifications';
import ParticipantsPane from '../pageobjects/ParticipantsPane';
import PreJoinScreen from '../pageobjects/PreJoinScreen';
import SecurityDialog from '../pageobjects/SecurityDialog';
import SettingsDialog from '../pageobjects/SettingsDialog';
import Toolbar from '../pageobjects/Toolbar';
import VideoQualityDialog from '../pageobjects/VideoQualityDialog';

import { LOG_PREFIX, logInfo } from './browserLogger';
import { IContext, IJoinOptions } from './types';

export const P1_DISPLAY_NAME = 'p1';
export const P2_DISPLAY_NAME = 'p2';
export const P3_DISPLAY_NAME = 'p3';
export const P4_DISPLAY_NAME = 'p4';

/**
 * Participant.
 */
export class Participant {
    /**
     * The current context.
     *
     * @private
     */
    private _name: string;
    private _displayName: string;
    private _endpointId: string;
    private _jwt?: string;

    /**
     * The default config to use when joining.
     *
     * @private
     */
    private config = {
        analytics: {
            disabled: true
        },
        requireDisplayName: false,
        testing: {
            testMode: true
        },
        disableAP: true,
        disable1On1Mode: true,
        disableModeratorIndicator: true,
        enableTalkWhileMuted: false,
        gatherStats: true,
        p2p: {
            enabled: false,
            useStunTurn: false
        },
        pcStatsInterval: 1500,
        prejoinConfig: {
            enabled: false
        },
        toolbarConfig: {
            alwaysVisible: true
        }
    } as IConfig;

    /**
     * Creates a participant with given name.
     *
     * @param {string} name - The name of the participant.
     * @param {string }jwt - The jwt if any.
     */
    constructor(name: string, jwt?: string) {
        this._name = name;
        this._jwt = jwt;
    }

    /**
     * Returns participant endpoint ID.
     *
     * @returns {Promise<string>} The endpoint ID.
     */
    async getEndpointId(): Promise<string> {
        if (!this._endpointId) {
            this._endpointId = await this.driver.execute(() => { // eslint-disable-line arrow-body-style
                return APP.conference.getMyUserId();
            });
        }

        return this._endpointId;
    }

    /**
     * The driver it uses.
     */
    get driver() {
        return multiremotebrowser.getInstance(this._name);
    }

    /**
     * The name.
     */
    get name() {
        return this._name;
    }

    /**
     * The name.
     */
    get displayName() {
        return this._displayName || this.name;
    }

    /**
     * Adds a log to the participants log file.
     *
     * @param {string} message - The message to log.
     * @returns {void}
     */
    log(message: string): void {
        logInfo(this.driver, message);
    }

    /**
     * Joins conference.
     *
     * @param {IContext} ctx - The context.
     * @param {IJoinOptions} options - Options for joining.
     * @returns {Promise<void>}
     */
    async joinConference(ctx: IContext, options: IJoinOptions = {}): Promise<void> {
        const config = {
            room: ctx.roomName,
            configOverwrite: {
                ...this.config,
                ...options.configOverwrite || {}
            },
            interfaceConfigOverwrite: {
                SHOW_CHROME_EXTENSION_BANNER: false
            }
        };

        if (!options.skipDisplayName) {
            // @ts-ignore
            config.userInfo = {
                displayName: this._displayName = options.displayName || this._name
            };
        }

        if (ctx.iframeAPI) {
            config.room = 'iframeAPITest.html';
        }

        let url = urlObjectToString(config) || '';

        if (ctx.iframeAPI) {
            const baseUrl = new URL(this.driver.options.baseUrl || '');

            // @ts-ignore
            url = `${this.driver.iframePageBase}${url}&domain="${baseUrl.host}"&room="${ctx.roomName}"`;

            if (baseUrl.pathname.length > 1) {
                // remove leading slash
                url = `${url}&tenant="${baseUrl.pathname.substring(1)}"`;
            }
        }
        if (this._jwt) {
            url = `${url}&jwt="${this._jwt}"`;
        }

        await this.driver.setTimeout({ 'pageLoad': 30000 });

        // drop the leading '/' so we can use the tenant if any
        await this.driver.url(url.startsWith('/') ? url.substring(1) : url);

        await this.waitForPageToLoad();

        if (ctx.iframeAPI) {
            const mainFrame = this.driver.$('iframe');

            await this.driver.switchFrame(mainFrame);
        }

        if (!options.skipWaitToJoin) {
            await this.waitToJoinMUC();
        }

        await this.postLoadProcess(options.skipInMeetingChecks);
    }

    /**
     * Loads stuff after the page loads.
     *
     * @param {boolean} skipInMeetingChecks - Whether to skip in meeting checks.
     * @returns {Promise<void>}
     * @private
     */
    private async postLoadProcess(skipInMeetingChecks = false): Promise<void> {
        const driver = this.driver;

        const parallel = [];

        parallel.push(driver.execute((name, sessionId, prefix) => {
            APP.UI.dockToolbar(true);

            // disable keyframe animations (.fadeIn and .fadeOut classes)
            $('<style>.notransition * { '
                + 'animation-duration: 0s !important; -webkit-animation-duration: 0s !important; transition:none; '
                + '} </style>') // @ts-ignore
                    .appendTo(document.head);

            // @ts-ignore
            $('body').toggleClass('notransition');

            document.title = `${name}`;

            console.log(`${new Date().toISOString()} ${prefix} sessionId: ${sessionId}`);

            // disable the blur effect in firefox as it has some performance issues
            const blur = document.querySelector('.video_blurred_container');

            if (blur) {
                // @ts-ignore
                document.querySelector('.video_blurred_container').style.display = 'none';
            }
        }, this._name, driver.sessionId, LOG_PREFIX));

        if (skipInMeetingChecks) {
            await Promise.allSettled(parallel);

            return;
        }

        parallel.push(this.waitForIceConnected());
        parallel.push(this.waitForSendReceiveData());

        await Promise.all(parallel);
    }

    /**
     * Waits for the page to load.
     *
     * @returns {Promise<void>}
     */
    async waitForPageToLoad(): Promise<void> {
        return this.driver.waitUntil(
            () => this.driver.execute(() => document.readyState === 'complete'),
            {
                timeout: 30_000, // 30 seconds
                timeoutMsg: `Timeout waiting for Page Load Request to complete for ${this.name}.`
            }
        );
    }

    /**
     * Waits for the tile view to display.
     */
    async waitForTileViewDisplay(reverse = false) {
        await this.driver.$('//div[@id="videoconference_page" and contains(@class, "tile-view")]').waitForDisplayed({
            reverse,
            timeout: 10_000,
            timeoutMsg: `Tile view did not display in 10s for ${this.name}`
        });
    }

    /**
     * Checks if the participant is in the meeting.
     */
    async isInMuc() {
        return await this.driver.execute(() => typeof APP !== 'undefined' && APP.conference?.isJoined());
    }

    /**
     * Checks if the participant is a moderator in the meeting.
     */
    async isModerator() {
        return await this.driver.execute(() => typeof APP !== 'undefined'
            && APP.store?.getState()['features/base/participants']?.local?.role === 'moderator');
    }

    /**
     * Checks if the meeting supports breakout rooms.
     */
    async isBreakoutRoomsSupported() {
        return await this.driver.execute(() => typeof APP !== 'undefined'
            && APP.store?.getState()['features/base/conference'].conference?.getBreakoutRooms()?.isSupported());
    }

    /**
     * Checks if the participant is in breakout room.
     */
    async isInBreakoutRoom() {
        return await this.driver.execute(() => typeof APP !== 'undefined'
            && APP.store?.getState()['features/base/conference'].conference?.getBreakoutRooms()?.isBreakoutRoom());
    }

    /**
     * Waits to join the muc.
     *
     * @returns {Promise<void>}
     */
    async waitToJoinMUC(): Promise<void> {
        return this.driver.waitUntil(
            () => this.isInMuc(),
            {
                timeout: 10_000, // 10 seconds
                timeoutMsg: `Timeout waiting to join muc for ${this.name}`
            }
        );
    }

    /**
     * Waits for ICE to get connected.
     *
     * @returns {Promise<void>}
     */
    async waitForIceConnected(): Promise<void> {
        const driver = this.driver;

        return driver.waitUntil(() =>
            driver.execute(() => APP.conference.getConnectionState() === 'connected'), {
            timeout: 15_000,
            timeoutMsg: `expected ICE to be connected for 15s for ${this.name}`
        });
    }

    /**
     * Waits for send and receive data.
     *
     * @returns {Promise<void>}
     */
    async waitForSendReceiveData(
            timeout = 15_000, msg = `expected to receive/send data in 15s for ${this.name}`): Promise<void> {
        const driver = this.driver;

        return driver.waitUntil(() => driver.execute(() => {
            const stats = APP.conference.getStats();
            const bitrateMap = stats?.bitrate || {};
            const rtpStats = {
                uploadBitrate: bitrateMap.upload || 0,
                downloadBitrate: bitrateMap.download || 0
            };

            return rtpStats.uploadBitrate > 0 && rtpStats.downloadBitrate > 0;
        }), {
            timeout,
            timeoutMsg: msg
        });
    }

    /**
     * Waits for send and receive data.
     *
     * @returns {Promise<void>}
     */
    async waitForSendData(
            timeout = 15_000, msg = `expected to send data in 15s for ${this.name}`): Promise<void> {
        const driver = this.driver;

        return driver.waitUntil(() => driver.execute(() => {
            const stats = APP.conference.getStats();
            const bitrateMap = stats?.bitrate || {};
            const rtpStats = {
                uploadBitrate: bitrateMap.upload || 0
            };

            return rtpStats.uploadBitrate > 0;
        }), {
            timeout,
            timeoutMsg: msg
        });
    }

    /**
     * Waits for remote streams.
     *
     * @param {number} number - The number of remote streams to wait for.
     * @returns {Promise<void>}
     */
    waitForRemoteStreams(number: number): Promise<void> {
        const driver = this.driver;

        return driver.waitUntil(() =>
            driver.execute(count => APP.conference.getNumberOfParticipantsWithTracks() >= count, number), {
            timeout: 15_000,
            timeoutMsg: `expected number of remote streams:${number} in 15s for ${this.name}`
        });
    }

    /**
     * Waits for number of participants.
     *
     * @param {number} number - The number of participant to wait for.
     * @param {string} msg - A custom message to use.
     * @returns {Promise<void>}
     */
    waitForParticipants(number: number, msg?: string): Promise<void> {
        const driver = this.driver;

        return driver.waitUntil(() => driver.execute(count => APP.conference.listMembers().length === count, number), {
            timeout: 15_000,
            timeoutMsg: msg || `not the expected participants ${number} in 15s for ${this.name}`
        });
    }

    /**
     * Returns the chat panel for this participant.
     */
    getChatPanel(): ChatPanel {
        return new ChatPanel(this);
    }

    /**
     * Returns the BreakoutRooms for this participant.
     *
     * @returns {BreakoutRooms}
     */
    getBreakoutRooms(): BreakoutRooms {
        return new BreakoutRooms(this);
    }

    /**
     * Returns the toolbar for this participant.
     *
     * @returns {Toolbar}
     */
    getToolbar(): Toolbar {
        return new Toolbar(this);
    }

    /**
     * Returns the filmstrip for this participant.
     *
     * @returns {Filmstrip}
     */
    getFilmstrip(): Filmstrip {
        return new Filmstrip(this);
    }

    /**
     * Returns the invite dialog for this participant.
     *
     * @returns {InviteDialog}
     */
    getInviteDialog(): InviteDialog {
        return new InviteDialog(this);
    }

    /**
     * Returns the notifications.
     */
    getNotifications(): Notifications {
        return new Notifications(this);
    }

    /**
     * Returns the participants pane.
     *
     * @returns {ParticipantsPane}
     */
    getParticipantsPane(): ParticipantsPane {
        return new ParticipantsPane(this);
    }

    /**
     * Returns the videoQuality Dialog.
     *
     * @returns {VideoQualityDialog}
     */
    getVideoQualityDialog(): VideoQualityDialog {
        return new VideoQualityDialog(this);
    }

    /**
     * Returns the security Dialog.
     *
     * @returns {SecurityDialog}
     */
    getSecurityDialog(): SecurityDialog {
        return new SecurityDialog(this);
    }

    /**
     * Returns the settings Dialog.
     *
     * @returns {SettingsDialog}
     */
    getSettingsDialog(): SettingsDialog {
        return new SettingsDialog(this);
    }

    /**
     * Returns the prejoin screen.
     */
    getPreJoinScreen(): PreJoinScreen {
        return new PreJoinScreen(this);
    }

    /**
     * Returns the lobby screen.
     */
    getLobbyScreen(): LobbyScreen {
        return new LobbyScreen(this);
    }

    /**
     * Switches to the iframe API context
     */
    async switchToAPI() {
        await this.driver.switchFrame(null);
    }

    /**
     * Switches to the meeting page context.
     */
    async switchInPage() {
        const mainFrame = this.driver.$('iframe');

        await this.driver.switchFrame(mainFrame);
    }

    /**
     * Returns the iframe API for this participant.
     */
    getIframeAPI() {
        return new IframeAPI(this);
    }

    /**
     * Hangups the participant by leaving the page. base.html is an empty page on all deployments.
     */
    async hangup() {
        const current = await this.driver.getUrl();

        // already hangup
        if (current.endsWith('/base.html')) {
            return;
        }

        // do a hangup, to make sure unavailable presence is sent
        await this.driver.execute(() => typeof APP !== 'undefined' && APP?.conference?.hangup());

        // let's give it some time to leave the muc, we redirect after hangup so we should wait for the
        // change of url
        await this.driver.waitUntil(
            async () => current !== await this.driver.getUrl(),
            {
                timeout: 5000,
                timeoutMsg: `${this.name} did not leave the muc in 5s`
            }
        );

        await this.driver.url('/base.html');
    }

    /**
     * Returns the local display name element.
     * @private
     */
    private async getLocalDisplayNameElement() {
        const localVideoContainer = this.driver.$('span[id="localVideoContainer"]');

        await localVideoContainer.moveTo();

        return localVideoContainer.$('span[id="localDisplayName"]');
    }

    /**
     * Returns the local display name.
     */
    async getLocalDisplayName() {
        return (await this.getLocalDisplayNameElement()).getText();
    }

    /**
     * Sets the display name of the local participant.
     */
    async setLocalDisplayName(displayName: string) {
        const localDisplayName = await this.getLocalDisplayNameElement();

        await localDisplayName.click();

        await this.driver.keys(displayName);
        await this.driver.keys(Key.Return);

        // just click somewhere to lose focus, to make sure editing has ended
        const localVideoContainer = this.driver.$('span[id="localVideoContainer"]');

        await localVideoContainer.moveTo();
        await localVideoContainer.click();
    }

    /**
     * Gets avatar SRC attribute for the one displayed on local video thumbnail.
     */
    async getLocalVideoAvatar() {
        const avatar
            = this.driver.$('//span[@id="localVideoContainer"]//img[contains(@class,"userAvatar")]');

        return await avatar.isExisting() ? await avatar.getAttribute('src') : null;
    }

    /**
     * Gets avatar SRC attribute for the one displayed on large video.
     */
    async getLargeVideoAvatar() {
        const avatar = this.driver.$('//img[@id="dominantSpeakerAvatar"]');

        return await avatar.isExisting() ? await avatar.getAttribute('src') : null;
    }

    /**
     * Returns resource part of the JID of the user who is currently displayed in the large video area.
     */
    async getLargeVideoResource() {
        return await this.driver.execute(() => APP.UI.getLargeVideoID());
    }

    /**
     * Returns the source of the large video currently shown.
     */
    async getLargeVideoId() {
        return this.driver.execute('return document.getElementById("largeVideo").srcObject.id');
    }

    /**
     * Makes sure that the avatar is displayed in the local thumbnail and that the video is not displayed.
     * There are 3 options for avatar:
     *  - defaultAvatar: true - the default avatar (with grey figure) is used
     *  - image: true - the avatar is an image set in the settings
     *  - defaultAvatar: false, image: false - the avatar is produced from the initials of the display name
     */
    async assertThumbnailShowsAvatar(
            participant: Participant, reverse = false, defaultAvatar = false, image = false): Promise<void> {
        const id = participant === this
            ? 'localVideoContainer' : `participant_${await participant.getEndpointId()}`;

        const xpath = defaultAvatar
            ? `//span[@id='${id}']//div[contains(@class,'userAvatar') and contains(@class, 'defaultAvatar')]`
            : `//span[@id="${id}"]//${image ? 'img' : 'div'}[contains(@class,"userAvatar")]`;

        await this.driver.$(xpath).waitForDisplayed({
            reverse,
            timeout: 2000,
            timeoutMsg: `Avatar is ${reverse ? '' : 'not'} displayed in the local thumbnail for ${participant.name}`
        });

        await this.driver.$(`//span[@id="${id}"]//video`).waitForDisplayed({
            reverse: !reverse,
            timeout: 2000,
            timeoutMsg: `Video is ${reverse ? 'not' : ''} displayed in the local thumbnail for ${participant.name}`
        });
    }

    /**
     * Makes sure that the default avatar is used.
     */
    async assertDefaultAvatarExist(participant: Participant): Promise<void> {
        const id = participant === this
            ? 'localVideoContainer' : `participant_${await participant.getEndpointId()}`;

        await this.driver.$(
            `//span[@id='${id}']//div[contains(@class,'userAvatar') and contains(@class, 'defaultAvatar')]`)
            .waitForExist({
                timeout: 2000,
                timeoutMsg: `Default avatar does not exist for ${participant.name}`
            });
    }

    /**
     * Makes sure that the local video is displayed in the local thumbnail and that the avatar is not displayed.
     */
    async asserLocalThumbnailShowsVideo(): Promise<void> {
        await this.assertThumbnailShowsAvatar(this, true);
    }

    /**
     * Make sure a display name is visible on the stage.
     * @param value
     */
    async assertDisplayNameVisibleOnStage(value: string) {
        const displayNameEl = this.driver.$('div[data-testid="stage-display-name"]');

        expect(await displayNameEl.isDisplayed()).toBe(true);
        expect(await displayNameEl.getText()).toBe(value);
    }

    /**
     * Checks if the leave reason dialog is open.
     */
    async isLeaveReasonDialogOpen() {
        return this.driver.$('div[data-testid="dialog.leaveReason"]').isDisplayed();
    }

    /**
     * Waits for remote video state - receiving and displayed.
     * @param endpointId
     */
    async waitForRemoteVideo(endpointId: string) {
        await this.driver.waitUntil(async () =>
            await this.driver.execute(epId => JitsiMeetJS.app.testing.isRemoteVideoReceived(`${epId}`),
                endpointId) && await this.driver.$(
                `//span[@id="participant_${endpointId}" and contains(@class, "display-video")]`).isExisting(), {
            timeout: 15_000,
            timeoutMsg: `expected remote video for ${endpointId} to be received 15s by ${this.name}`
        });
    }

    /**
     * Waits for ninja icon to be displayed.
     * @param endpointId
     */
    async waitForNinjaIcon(endpointId: string) {
        await this.driver.$(`//span[@id='participant_${endpointId}']//span[@class='connection_ninja']`)
            .waitForDisplayed({
                timeout: 15_000,
                timeoutMsg: `expected ninja icon for ${endpointId} to be displayed in 15s by ${this.name}`
            });
    }
}
