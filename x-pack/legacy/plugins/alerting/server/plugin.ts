/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import Hapi from 'hapi';

import { Services } from './types';
import { AlertsClient } from './alerts_client';
import { AlertTypeRegistry } from './alert_type_registry';
import { TaskRunnerFactory } from './task_runner';
import { AlertsClientFactory } from './alerts_client_factory';
import { LicenseState } from './lib/license_state';
import { IClusterClient, KibanaRequest, Logger } from '../../../../../src/core/server';
import {
  AlertingPluginInitializerContext,
  AlertingCoreSetup,
  AlertingCoreStart,
  AlertingPluginsSetup,
  AlertingPluginsStart,
} from './shim';
import {
  createAlertRoute,
  deleteAlertRoute,
  findAlertRoute,
  getAlertRoute,
  getAlertStateRoute,
  listAlertTypesRoute,
  updateAlertRoute,
  enableAlertRoute,
  disableAlertRoute,
  updateApiKeyRoute,
  muteAllAlertRoute,
  unmuteAllAlertRoute,
  muteAlertInstanceRoute,
  unmuteAlertInstanceRoute,
} from './routes';
import { extendRouteWithLicenseCheck } from './extend_route_with_license_check';

export interface PluginSetupContract {
  registerType: AlertTypeRegistry['register'];
}
export interface PluginStartContract {
  listTypes: AlertTypeRegistry['list'];
  getAlertsClientWithRequest(request: Hapi.Request): PublicMethodsOf<AlertsClient>;
}

export class Plugin {
  private readonly logger: Logger;
  private alertTypeRegistry?: AlertTypeRegistry;
  private readonly taskRunnerFactory: TaskRunnerFactory;
  private adminClient?: IClusterClient;
  private serverBasePath?: string;
  private licenseState: LicenseState | null = null;
  private isESOUsingEphemeralEncryptionKey?: boolean;

  constructor(initializerContext: AlertingPluginInitializerContext) {
    this.logger = initializerContext.logger.get('plugins', 'alerting');
    this.taskRunnerFactory = new TaskRunnerFactory();
  }

  public async setup(
    core: AlertingCoreSetup,
    plugins: AlertingPluginsSetup
  ): Promise<PluginSetupContract> {
    this.adminClient = core.elasticsearch.adminClient;
    this.licenseState = new LicenseState(plugins.licensing.license$);
    this.isESOUsingEphemeralEncryptionKey =
      plugins.encryptedSavedObjects.usingEphemeralEncryptionKey;

    if (this.isESOUsingEphemeralEncryptionKey) {
      this.logger.warn(
        'APIs are disabled due to the Encrypted Saved Objects plugin using an ephemeral encryption key. Please set xpack.encryptedSavedObjects.encryptionKey in kibana.yml.'
      );
    }

    // Encrypted attributes
    plugins.encryptedSavedObjects.registerType({
      type: 'alert',
      attributesToEncrypt: new Set(['apiKey']),
      attributesToExcludeFromAAD: new Set([
        'scheduledTaskId',
        'muteAll',
        'mutedInstanceIds',
        'updatedBy',
      ]),
    });

    const alertTypeRegistry = new AlertTypeRegistry({
      taskManager: plugins.taskManager,
      taskRunnerFactory: this.taskRunnerFactory,
    });
    this.alertTypeRegistry = alertTypeRegistry;
    this.serverBasePath = core.http.basePath.serverBasePath;

    // Register routes
    core.http.route(extendRouteWithLicenseCheck(createAlertRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(deleteAlertRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(findAlertRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(getAlertRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(getAlertStateRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(listAlertTypesRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(updateAlertRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(enableAlertRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(disableAlertRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(updateApiKeyRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(muteAllAlertRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(unmuteAllAlertRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(muteAlertInstanceRoute, this.licenseState));
    core.http.route(extendRouteWithLicenseCheck(unmuteAlertInstanceRoute, this.licenseState));

    return {
      registerType: alertTypeRegistry.register.bind(alertTypeRegistry),
    };
  }

  public start(core: AlertingCoreStart, plugins: AlertingPluginsStart): PluginStartContract {
    const { adminClient, serverBasePath, isESOUsingEphemeralEncryptionKey } = this;

    function spaceIdToNamespace(spaceId?: string): string | undefined {
      const spacesPlugin = plugins.spaces();
      return spacesPlugin && spaceId ? spacesPlugin.spaceIdToNamespace(spaceId) : undefined;
    }

    const alertsClientFactory = new AlertsClientFactory({
      alertTypeRegistry: this.alertTypeRegistry!,
      logger: this.logger,
      taskManager: plugins.taskManager,
      securityPluginSetup: plugins.security,
      encryptedSavedObjectsPlugin: plugins.encryptedSavedObjects,
      spaceIdToNamespace,
      getSpaceId(request: Hapi.Request) {
        const spacesPlugin = plugins.spaces();
        return spacesPlugin ? spacesPlugin.getSpaceId(request) : undefined;
      },
    });

    this.taskRunnerFactory.initialize({
      logger: this.logger,
      getServices(rawRequest: Hapi.Request): Services {
        const request = KibanaRequest.from(rawRequest);
        return {
          callCluster: (...args) => adminClient!.asScoped(request).callAsCurrentUser(...args),
          // rawRequest is actually a fake request, converting it to KibanaRequest causes issue in SO access
          savedObjectsClient: core.savedObjects.getScopedSavedObjectsClient(rawRequest as any),
        };
      },
      spaceIdToNamespace,
      executeAction: plugins.actions.execute,
      encryptedSavedObjectsPlugin: plugins.encryptedSavedObjects,
      getBasePath(spaceId?: string): string {
        const spacesPlugin = plugins.spaces();
        return spacesPlugin && spaceId ? spacesPlugin.getBasePath(spaceId) : serverBasePath!;
      },
    });

    return {
      listTypes: this.alertTypeRegistry!.list.bind(this.alertTypeRegistry!),
      getAlertsClientWithRequest: (request: Hapi.Request) => {
        if (isESOUsingEphemeralEncryptionKey === true) {
          throw new Error(
            `Unable to create alerts client due to the Encrypted Saved Objects plugin using an ephemeral encryption key. Please set xpack.encryptedSavedObjects.encryptionKey in kibana.yml`
          );
        }
        return alertsClientFactory!.create(KibanaRequest.from(request), request);
      },
    };
  }

  public stop() {
    if (this.licenseState) {
      this.licenseState.clean();
    }
  }
}
