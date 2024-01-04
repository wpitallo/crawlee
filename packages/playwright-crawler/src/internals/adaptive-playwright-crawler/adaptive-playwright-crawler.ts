import { addTimeoutToPromise } from '@apify/timeout';
import { MemoryStorage } from '@crawlee/memory-storage';
import type { BatchAddRequestsResult } from '@crawlee/types';
import { extractUrlsFromCheerio } from '@crawlee/utils';
import { load, type CheerioAPI } from 'cheerio';

import { calculateChangeRatio, type RenderingType } from './rendering-type-detection';
import { RenderingTypePredictor } from './rendering-type-prediction';
import type { Configuration, EnqueueLinksOptions, PlaywrightCrawlingContext, PlaywrightCrawlerOptions, BasicCrawlerOptions, Dictionary } from '../..';
import { PlaywrightCrawler } from '../..';

interface RequestHandlerRunResult {
  enqueuedLinks: string[];
  datasetEntries: Dictionary[];
}

interface DryRunResult extends RequestHandlerRunResult {
  $: CheerioAPI;
}

const createTemporaryStorageClient = () => new MemoryStorage({ persistStorage: false, writeMetadata: false });

// TODO a more limited crawling context type
export interface AdaptiveCrawlerOptions extends PlaywrightCrawlerOptions {
  dryRunRatio: number;
  renderingTypeDetectionHandler: (input: {
    static$: CheerioAPI;
    dynamic$: CheerioAPI;
    staticToDynamicChangeRatio: number | null;
    mutationCount: number;
    url: string;
    browserRunResult: RequestHandlerRunResult;
    httpOnlyRunResult: RequestHandlerRunResult;
  }) => Promise<RenderingType>;
  datasetEntryChecker: (datasetEntry: Dictionary) => boolean;
}

export class AdaptiveCrawler extends PlaywrightCrawler {
    private options: BasicCrawlerOptions<any>;
    private renderingTypeDetectionHandler: AdaptiveCrawlerOptions['renderingTypeDetectionHandler'];
    private datasetEntryChecker: AdaptiveCrawlerOptions['datasetEntryChecker'];

    private renderingTypePredictor: RenderingTypePredictor;

    constructor({ renderingTypeDetectionHandler, datasetEntryChecker, dryRunRatio, ...options }: AdaptiveCrawlerOptions, config?: Configuration) {
        super(
            {
                ...options,
                postNavigationHooks: [
                    async ({ page, request: { userData } }) => {
                        userData.mutationCount = 0;

                        function trackMutations(count: number) {
                            userData.mutationCount += count;
                        }
                        await page.exposeFunction(trackMutations.name, trackMutations);

                        const body = await page.$('body');
                        if (body !== null) {
                            await body.evaluate((bodyHandle) => {
                                const observer = new MutationObserver((mutations) => trackMutations(mutations.length));
                                observer.observe(bodyHandle, {
                                    childList: true,
                                    subtree: true,
                                    characterData: true,
                                });
                            });
                        }
                    },
                ],
            },
            config,
        );
        this.options = options;
        this.renderingTypeDetectionHandler = renderingTypeDetectionHandler;
        this.datasetEntryChecker = datasetEntryChecker;
        this.renderingTypePredictor = new RenderingTypePredictor({ dryRunRatio });
    }

    protected override async _runRequestHandler(crawlingContext: PlaywrightCrawlingContext): Promise<void> {
        const url = new URL(crawlingContext.request.loadedUrl ?? crawlingContext.request.url);

        const renderingTypePrediction = this.renderingTypePredictor.predict(url);
        const shouldDetectRenderingType = Math.random() < renderingTypePrediction.detectionProbabilityRecommendation;

        const httpOnlyRunResult = shouldDetectRenderingType ? await this._dryRunRequestHandlerWithPlainHTTP(crawlingContext) : undefined;

        crawlingContext.log.info(
            `Rendering type prediction ${
                renderingTypePrediction.renderingType
            } (rec. detection probability ${
                renderingTypePrediction.detectionProbabilityRecommendation
            }): ${
                crawlingContext.request.url
            }`,
        );

        if (renderingTypePrediction.renderingType === 'clientOnly' || shouldDetectRenderingType) {
            if (shouldDetectRenderingType) {
                crawlingContext.log.info(`Trying to detect rendering type: ${crawlingContext.request.url}`);
            } else if (renderingTypePrediction.renderingType === 'clientOnly') {
                crawlingContext.log.info(`Crawling with Playwright: ${crawlingContext.request.url}`);
            }

            const browserRunResult = await this._runRequestHandlerInBrowser(crawlingContext);

            if (shouldDetectRenderingType && httpOnlyRunResult !== undefined && browserRunResult !== undefined) {
                const playwright$ = load(await crawlingContext.page.content());
                const staticToDynamicChangeRatio = calculateChangeRatio(httpOnlyRunResult.$, playwright$);
                const mutationCount: number = (crawlingContext.request.userData as Record<string, any>).mutationCount ?? 0;

                const detectionResult = await this.renderingTypeDetectionHandler({
                    static$: httpOnlyRunResult.$,
                    dynamic$: playwright$,
                    staticToDynamicChangeRatio,
                    mutationCount,
                    url: crawlingContext.request.loadedUrl ?? crawlingContext.request.url,
                    browserRunResult,
                    httpOnlyRunResult,
                });

                crawlingContext.log.info(`Rendering type '${detectionResult}' detected for page ${crawlingContext.request.url}`);

                this.renderingTypePredictor.storeResult(url, detectionResult);
            }
        } else {
            crawlingContext.log.info(`Crawling with plain HTTP: ${crawlingContext.request.url}`);

            const dryRunResult = await this._dryRunRequestHandlerWithPlainHTTP(crawlingContext);

            if (dryRunResult === undefined || dryRunResult.datasetEntries.some((entry) => !this.datasetEntryChecker(entry))) {
                crawlingContext.log.info(`Suspicious dataset entry detected, restarting with Playwright: ${crawlingContext.request.url}`);
                await super._runRequestHandler(crawlingContext);
            } else {
                dryRunResult.datasetEntries.forEach(async (entry) => this.pushData(entry));
                // TODO insert enqueued links as well
            }
        }
    }

    protected async _dryRunRequestHandlerWithPlainHTTP(crawlingContext: PlaywrightCrawlingContext): Promise<DryRunResult | undefined> {
        const response = await crawlingContext.sendRequest();
        const $ = load(response.body);

        const result: DryRunResult = {
            $,
            enqueuedLinks: [],
            datasetEntries: [],
        };

        try {
            await addTimeoutToPromise(
                async () => Promise.resolve(
            this.options.requestHandler!({
                id: crawlingContext.id,
                request: { ...crawlingContext.request, loadedUrl: crawlingContext.request.url } as any,
                log: crawlingContext.log,
                enqueueLinks: async (options: EnqueueLinksOptions) => {
                    const urls = extractUrlsFromCheerio($, options.selector, crawlingContext.request.url);
                    result.enqueuedLinks.push(...urls);

                    return {
                        processedRequests: [],
                        unprocessedRequests: [],
                    } satisfies BatchAddRequestsResult;
                },
                sendRequest: crawlingContext.sendRequest,
                pushData: async (data: Dictionary | Dictionary[]) => {
                    if (Array.isArray(data)) {
                        result.datasetEntries.push(...data);
                    } else {
                        result.datasetEntries.push(data);
                    }
                },
                crawler: null as any, // TODO either pass `this` (if it's safe) or some dummy object
                page: null as any,
                $,
                parseWithCheerio: async () => $,
                response,
                body: response.body,
                json: {},
                contentType: { type: 'text/html', encoding: 'utf8' },
            }),
                ),
                this.requestHandlerTimeoutInnerMillis,
                'Request handler timed out',
            );

            return result;
        } catch (e) {
            crawlingContext.log.exception(e as Error, 'Exception while probing');
            return undefined;
        }
    }

    protected async _runRequestHandlerInBrowser(crawlingContext: PlaywrightCrawlingContext): Promise<DryRunResult | undefined> {
        const browserRunResult: RequestHandlerRunResult = { enqueuedLinks: [], datasetEntries: [] };

        await super._runRequestHandler(
            new Proxy(crawlingContext, {
                get: (target, propertyName, receiver) => {
                    if (propertyName === 'enqueueLinks') {
                        return async (options?: EnqueueLinksOptions) => {
                            const urls = extractUrlsFromCheerio(await crawlingContext.parseWithCheerio(), options?.selector)
                            browserRunResult.enqueuedLinks.push(...urls)

                            return await target.enqueueLinks(options);
                        };
                    }

                    if (propertyName === 'pushData') {
                        return async (data: Dictionary | Dictionary[]) => {
                            if (Array.isArray(data)) {
                                browserRunResult.datasetEntries.push(...data);
                            } else {
                                browserRunResult.datasetEntries.push(data);
                            }
                            return await target.pushData(data);
                        };
                    }

                    return Reflect.get(target, propertyName, receiver);
                },
            }),
        );

        return { ...browserRunResult, $: await crawlingContext.parseWithCheerio() };
    }
}
