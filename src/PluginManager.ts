import * as semver from "semver";
import { ILogger, IPlugin, IPluginManifest } from "plugin-api";
import { MixedCollection } from "./MixedCollection";
import { EntityCollection, EntityType } from "./EntityCollection";
import { PluginApiRuntime } from "./PluginApiRuntime";
import { PageStructureReader } from "./PageStructureReader";
import { PluginLoader } from "./PluginLoader";
import { CmsConfig } from "./CmsConfig";
import { ICmsRendererConfig } from "./component/ICmsRendererConfig";
import { PluginUrlBuilder } from "./PluginUrlBuilder";
import { PluginValidator } from "./PluginValidator";
import { IInlinePlugin } from "./IInlinePlugin";
import { PageStructureValidator } from "./PageStructureValidator";
import { version as cmsVersion } from "./version";

export class PluginManager {
    constructor(
        private logger: ILogger,
        private config: CmsConfig,
        private inlinePlugins?: Map<string, () => Promise<IInlinePlugin>>
    ) {

    }

    async loadPlugins() {
        let plugins = new MixedCollection<string, IPlugin>();
        let entitiesByPlugin = new Map<string, EntityCollection>();
        let allEntities = new EntityCollection();
        let pageEntityOwnerPlugins = new Map<EntityType, string>();

        new PluginApiRuntime().init(window);

        for (let pluginUri of this.config.getPluginUris()) {
            try {
                let pluginConfig = this.config.getPluginConfig(pluginUri);
                let pluginVersion = new URL(pluginUri).searchParams.get("v") || void 0;
                this.logger.info(`Loading plugin ${pluginUri}...`);
                pluginUri = pluginUri.split("?")[0];

                let pluginEntities = new EntityCollection();

                let plugin: IPlugin;
                if (this.inlinePlugins && this.inlinePlugins.has(pluginUri) && pluginUri.match(/^inline-plugin:\/\//)) {
                    let inlinePlugin = await this.inlinePlugins.get(pluginUri)!();
                    inlinePlugin.init(pluginConfig, pluginEntities, this.logger);
                    plugin = inlinePlugin;
                } else {
                    let pluginUrlBuilder = new PluginUrlBuilder(this.config.getPluginsBaseUrl());
                    let pluginModule = await new PluginLoader(pluginUrlBuilder).load(pluginUri, pluginVersion);
                    this.checkPluginManifest(pluginUri, pluginModule.manifest);
                    plugin = pluginModule.plugin;
                    let pluginPublicPath = pluginUrlBuilder.build(pluginUri, pluginVersion) + "/";
                    plugin.init(pluginConfig, pluginEntities, this.logger, pluginPublicPath);
                }

                new PluginValidator().validate(plugin, pluginEntities);
                plugins.add(pluginUri, plugin);

                entitiesByPlugin.set(pluginUri, pluginEntities);
                allEntities.merge(pluginEntities);
                [...pluginEntities.getPageEntities().values()].forEach(v => pageEntityOwnerPlugins.set(v, pluginUri));
            } catch (e) {
                this.logger.error(`Failed loading plugin ${pluginUri}`, e);
            }
        }
        this.logger.info("Plugins loaded.");

        let pagesConfig = this.config.getPages();
        let pageStructureReader = new PageStructureReader(
            allEntities.getPageEntities(), new PageStructureValidator(), pageEntityOwnerPlugins, this.logger
        );

        let rootModules = pageStructureReader.readModuleMap(this.config.getRootModules());
        let pages = pageStructureReader.read(pagesConfig);
        let dataAdapters = allEntities.getDataAdapters();

        this.logger.info("Loading data sources...");
        await Promise.all([...allEntities.getDataSources().values()].map(dataSource => dataSource.init()));
        this.logger.info("Data sources loaded.");

        let cmsRendererConfig: ICmsRendererConfig = {
            plugins,
            pages,
            dataAdapters,
            rootModules
        };

        return cmsRendererConfig;
    }

    private checkPluginManifest(pluginUri: string, manifest: IPluginManifest | undefined) {
        if (!manifest) {
            this.logger.warn(`Legacy plugin detected. Plugin "${pluginUri}" doesn't have a manifest. ` +
                `\nMost likely the plugin was generated with an outdated cms-plugin-tool. ` +
                `\n\nTo remove this warning, please migrate the plugin to the new format, ` +
                `by applying the changes at https://github.com/Alethio/cms-plugin-tool/pull/8/files`);
            return;
        }
        if (manifest.cmsVersion) {
            if (!semver.validRange(manifest.cmsVersion)) {
                this.logger.error(`Invalid manifest for plugin "${pluginUri}". ` +
                    `"${manifest.cmsVersion}" is not a valid semver range.`);
            } else if (!semver.satisfies(cmsVersion, manifest.cmsVersion)) {
                this.logger.error(`Plugin "${pluginUri}" requires a different Alethio CMS version ` +
                    `(expected = "${manifest.cmsVersion}"; actual = "${cmsVersion}").` +
                    `\n\nWe will attempt to load the plugin now, but it may not work correctly.`);
            }
        }
    }
}
