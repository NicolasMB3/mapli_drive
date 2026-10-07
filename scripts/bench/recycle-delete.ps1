<#
.SYNOPSIS
  Supprime un fichier « vers la corbeille », comme la touche Suppr de l'Explorateur.

.DESCRIPTION
  SHFileOperation avec FOF_ALLOWUNDO (c'est ce que fait l'Explorateur), sans aucune boîte
  de dialogue (FOF_SILENT, FOF_NOCONFIRMATION, FOF_NOERRORUI). Si le volume n'a pas de
  corbeille, Windows supprime définitivement, sans demander (pas de FOF_WANTNUKEWARNING).

  À lancer dans un processus STA à part (pwsh -STA -File) : l'appelant (windows-bench.ps1)
  l'arrête s'il ne rend pas la main — une boîte de dialogue invisible ne doit jamais
  bloquer le banc.

  Sortie : une ligne JSON { code, interrompu, dansLaCorbeille } — code 0 : opération
  réussie ; dansLaCorbeille : le fichier figure dans la corbeille de Windows.
#>
param([Parameter(Mandatory)] [string] $Path)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MapliShellDelete
{
    // Disposition naturelle : celle de shellapi.h en 64 bits.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEOPSTRUCT
    {
        public IntPtr hwnd;
        public uint wFunc;
        [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
        [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
        public ushort fFlags;
        [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
        public IntPtr hNameMappings;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperationW(ref SHFILEOPSTRUCT op);

    private const uint FO_DELETE = 3;
    private const ushort FOF_SILENT = 0x0004;
    private const ushort FOF_NOCONFIRMATION = 0x0010;
    private const ushort FOF_ALLOWUNDO = 0x0040;
    private const ushort FOF_NOCONFIRMMKDIR = 0x0200;
    private const ushort FOF_NOERRORUI = 0x0400;

    public static int Recycle(string path, out bool aborted)
    {
        var op = new SHFILEOPSTRUCT();
        op.wFunc = FO_DELETE;
        // Liste terminée par deux zéros : le second s'ajoute au marshalling.
        op.pFrom = path + "\0";
        op.fFlags = (ushort)(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOCONFIRMMKDIR | FOF_NOERRORUI);
        int code = SHFileOperationW(ref op);
        aborted = op.fAnyOperationsAborted;
        return code;
    }
}
'@

$aborted = $false
$code = [MapliShellDelete]::Recycle($Path, [ref] $aborted)

# La corbeille de Windows (dossier spécial 10) contient-elle le fichier ? Son nom peut s'y
# afficher sans extension (réglage de l'Explorateur).
$leaf = Split-Path -Leaf $Path
$stem = [IO.Path]::GetFileNameWithoutExtension($leaf)
$inBin = $false
try {
  $bin = (New-Object -ComObject Shell.Application).NameSpace(10)
  foreach ($item in $bin.Items()) {
    if ($item.Name -eq $leaf -or $item.Name -eq $stem) { $inBin = $true; break }
  }
} catch {
  $inBin = $null
}

[pscustomobject]@{ code = $code; interrompu = $aborted; dansLaCorbeille = $inBin } |
  ConvertTo-Json -Compress
