# Copyright (c) 2026 Naotsun

# Rules that New-VersionManifest.ps1 combines with the UBT module graph of the target.
# The module graph alone is not enough: UnrealBuildTool and the toolchain read files that no module declares.
# Every entry below was found by a build that failed without it, or by recording which files a full build read.
@{
    Target        = 'VerseCmd'
    Platform      = 'Win64'
    Configuration = 'Development'

    # Directories checked out in addition to the module directories of the target.
    ExtraSparsePaths = @(
        # UnrealBuildTool is built from source before every build, and its solution also references the
        # Tests and GenerateDocumentation projects, so the build fails if those are missing.
        'Engine/Build'
        'Engine/Config'
        'Engine/Source/Programs/UnrealBuildTool'
        'Engine/Source/Programs/UnrealBuildTool.Tests'
        'Engine/Source/Programs/UnrealBuildTool.GenerateDocumentation'
        'Engine/Source/Programs/Shared'

        # Core includes these headers by path through Engine/Source, so no module depends on them.
        'Engine/Source/ThirdParty/SSEMathFun'

        # Downloads the binary dependencies; it is tracked in git so that it exists before anything is downloaded.
        'Engine/Binaries/DotNET/GitDependencies'

        # Native libraries that the UnrealBuildTool build copies next to itself.
        'Engine/Binaries/DotNET/EpicGames.Perforce.Native'

        # The bundled .NET SDK that builds and runs UnrealBuildTool.
        'Engine/Binaries/ThirdParty/DotNet'

        # Runtime DLLs that the target copies next to verse.exe.
        'Engine/Binaries/ThirdParty/DbgHelp'
        'Engine/Binaries/ThirdParty/Windows/WinPixEventRuntime'

        # The in-tree compiler. UnrealBuildTool enumerates this directory when it looks for toolchains and fails
        # if it does not exist, and the target compiles with it because it enables AutoRTFM.
        'Engine/Binaries/Win64/EpicClang'

        # UnrealBuildAccelerator runs the compile actions. UnrealBuildTool also reads its libraries for the
        # other host platforms.
        'Engine/Binaries/Win64/UnrealBuildAccelerator'
        'Engine/Binaries/Linux/UnrealBuildAccelerator'
        'Engine/Binaries/LinuxArm64/UnrealBuildAccelerator'
        'Engine/Binaries/Mac/UnrealBuildAccelerator'

        # Configuration that UnrealHeaderTool reads while generating reflection code.
        'Engine/Programs/UnrealHeaderTool'

        # Debugger visualizers that the linker embeds.
        'Engine/Extras/VisualStudioDebugging'

        # Platform extension rules such as Chaos_Windows.Build.cs. Without them the build still succeeds but
        # silently uses different settings for those modules.
        'Engine/Platforms/Windows'

        # Not needed by the build. The VS Code extension reads the Verse syntax grammar from here; in cone mode
        # this also checks out verse-language-configuration.json, which sits in the parent directory.
        'Engine/Source/Programs/UnrealVS/UnrealVS/Grammars'
    )

    # Paths that keep the binary dependencies of every host platform. The UnrealBuildTool build copies the
    # Linux and Mac libraries even on Windows, so excluding them by folder name breaks it.
    AllPlatformPaths = @(
        'Engine/Binaries/DotNET'
        'Engine/Source/Programs/Shared'
        'Engine/Source/Programs/UnrealBuildTool'
        'Engine/Source/Programs/UnrealBuildTool.Tests'
        'Engine/Source/Programs/UnrealBuildTool.GenerateDocumentation'
        'Engine/Binaries/Linux/UnrealBuildAccelerator'
        'Engine/Binaries/LinuxArm64/UnrealBuildAccelerator'
        'Engine/Binaries/Mac/UnrealBuildAccelerator'
    )

    # Folder names whose binary dependencies are only used on other host platforms. They are excluded everywhere
    # except under AllPlatformPaths.
    OtherOsFolders = @(
        'Linux', 'LinuxArm64', 'LinuxAArch64', 'linux-x64', 'linux-arm64', 'linux-arm', 'linux-musl-x64', 'Unix'
        'Mac', 'MacOS', 'mac-x64', 'mac-arm64', 'osx', 'osx-x64', 'osx-arm64'
        'win-arm64'
        'Android', 'IOS', 'TVOS', 'VisionOS', 'HTML5'
    )

    # Single binary dependency files outside the directories above.
    ExtraGitDependencyFiles = @(
        # UnrealBuildTool runs this prebuilt tool to generate the Verse native interface (VNI) glue code.
        'Engine/Binaries/Win64/VerseCompilerCmd.exe'
    )
}
